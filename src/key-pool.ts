// 基础设施层·上游 key 池内存权威态（KeyPool）。
// 每 provider 一把，由该 provider 的 QueueDO（durable-object.ts）持有；同一进程单点写者：
//   - 冷却（cooldown_until）与熔断连续计数（breaker: Map）只在本池内存被改，
//     选 key（retry.ts emit(init) 读 pool.getKeys()）读到的就是刚写入的值——强一致。
//   - D1 仅是低频 checkpoint 备份：checkpointCooldowns 批量写回 cooldown_until。
//     丢失方向安全：冷却丢 = 提前放行、熔断计数丢 = 重新计数，均为放宽非锁死。
//   - D1 对 id/key/name/status/created_at 仍权威（admin 写），本池经 reload 合并采纳。
// admin 写 D1 后经 notifyKeyPoolSync 推式全量重读（worker → DO /_internal/sync-keys），
// 另有 RELOAD_FLOOR_MS 陈旧兜底重读（drain 每任务前 maybeReload）。
// checkpoint 失败静默（保留 dirty 下轮重试），复用 usage-store 的静默风格，不阻塞主流程。

import type { Env } from "./types";
import type { UpstreamDef, CoreKey } from "./domain";
import { listUpstreamKeys, checkpointCooldowns } from "./storage/upstream-keys";

/** 熔断连续计数：仅内存权威，不落库（重启用 0，安全方向）。 */
export interface BreakerMem {
  consecutive: number;
  updated_at: number;
  created_at: number;
}

export interface KeyPool {
  /** 返回当前内部数组；元素对象被 applyBreakerOutcome 原地改（选 key 即刻可见最新冷却）。 */
  getKeys(): CoreKey[];
  getBreakerState(id: string): BreakerMem | null;
  /** 原地写某次上游结果的 cooldown + 可选熔断计数，并标记 dirty（待 checkpoint）。 */
  applyBreakerOutcome(id: string, cooldownUntil: number, consecutive: number | null, now: number): void;
  /** 未加载或超 RELOAD_FLOOR_MS 才拉 D1（冷启动 + 陈旧兜底）。 */
  maybeReload(): Promise<void>;
  /** 合并重读：采纳 D1 的 name/status、清理已删 id，保留内存 cooldown 与计数。 */
  reload(): Promise<void>;
  /** 阈值节流落库（dirty 条数或距上次 checkpoint 间隔）；未到即 0 D1。 */
  maybeCheckpoint(): Promise<void>;
  /** 无条件落库（drain 收尾用）；失败静默保留 dirty。 */
  flushNow(): Promise<void>;
}

export const CHECKPOINT_INTERVAL_MS = 30_000; // 上次 checkpoint 距今超过则落库
export const CHECKPOINT_MIN_DIRTY = 16;       // dirty 条数达到则落库
export const RELOAD_FLOOR_MS = 60_000;        // 内存态陈旧上限，admin push 之外的自愈兜底

export function createKeyPool(env: Env, def: UpstreamDef, seed?: CoreKey[]): KeyPool {
  let keys: CoreKey[] = seed ? [...seed] : [];
  const breaker = new Map<string, BreakerMem>();
  const dirty = new Set<string>();
  let loaded = seed !== undefined;
  let loadedAt = seed !== undefined ? Date.now() : 0;
  let lastCheckpointAt = 0;
  let reloading: Promise<void> | null = null;
  let checkpointing = false;

  function applyBreakerOutcome(
    id: string,
    cooldownUntil: number,
    consecutive: number | null,
    now: number
  ): void {
    const key = keys.find((k) => k.id === id);
    if (!key) return; // 已删 key 竞态：不建脏条目
    // 原地改：retry 的 ctx.keys 快照即刻可见最新冷却（强一致的关键）
    key.cooldown_until = cooldownUntil;
    if (consecutive !== null) {
      breaker.set(id, {
        consecutive,
        updated_at: now,
        created_at: breaker.get(id)?.created_at ?? now,
      });
    }
    dirty.add(id);
  }

  async function reload(): Promise<void> {
    const rows = await listUpstreamKeys(env, def);
    const byId = new Map(rows.map((r) => [r.id, r]));
    const old = new Map(keys.map((k) => [k.id, k]));
    // 合并重建：id 已在旧内存 → 复用同一对象，采纳 D1 的 name/status（admin 写后需生效），
    // 保留内存 cooldown_until（内存永远更新）；id 不在 → 用 D1 行新建（cooldown 取自 D1，通常 null）。
    keys = rows.map((row) => {
      const existing = old.get(row.id);
      if (existing) {
        existing.name = row.name;
        existing.status = row.status;
        return existing;
      }
      return { ...row };
    });
    // 熔断计数只保留仍存在的 id（已删 key 的计数一并清理）；cooldown 已随 keys 重建生效。
    for (const id of breaker.keys()) {
      if (!byId.has(id)) breaker.delete(id);
    }
    loaded = true;
    loadedAt = Date.now();
    // 不清 dirty：未落库的冷却仍要补写；checkpoint 只写「dirty ∩ 当前存在」的 id。
  }

  async function maybeReload(): Promise<void> {
    if (loaded && Date.now() - loadedAt < RELOAD_FLOOR_MS) return;
    if (!reloading) {
      reloading = reload();
      try {
        await reloading;
      } finally {
        reloading = null;
      }
    } else {
      await reloading; // 并发去重：他人正在拉，等待同一结果
    }
  }

  async function flushNow(): Promise<void> {
    if (checkpointing) return; // 防重入
    checkpointing = true;
    try {
      if (dirty.size === 0) return;
      const entries = [...dirty]
        .map((id) => keys.find((k) => k.id === id))
        .filter((k): k is CoreKey => Boolean(k))
        .map((k) => ({ id: k.id, cooldown_until: k.cooldown_until }));
      await checkpointCooldowns(env, def, entries);
      for (const e of entries) dirty.delete(e.id);
      lastCheckpointAt = Date.now();
    } catch {
      // 写失败静默：保留 dirty，下轮（下次任务后或 drain 收尾）重试
    } finally {
      checkpointing = false;
    }
  }

  async function maybeCheckpoint(): Promise<void> {
    if (dirty.size === 0) return;
    const now = Date.now();
    if (dirty.size >= CHECKPOINT_MIN_DIRTY || now - lastCheckpointAt >= CHECKPOINT_INTERVAL_MS) {
      await flushNow();
    }
  }

  return {
    getKeys: () => keys,
    getBreakerState: (id) => breaker.get(id) ?? null,
    applyBreakerOutcome,
    maybeReload,
    reload,
    maybeCheckpoint,
    flushNow,
  };
}

/** admin 每次写 D1 后调用：让该 provider 的 QueueDO 立刻全量重读合并。尽力而为，调用方接 .catch(noop)。 */
export async function notifyKeyPoolSync(env: Env, provider: string): Promise<void> {
  const id = env.QUEUE.idFromName(provider);
  const stub = env.QUEUE.get(id);
  await stub.fetch("https://queue.internal/_internal/sync-keys", {
    method: "POST",
    body: JSON.stringify({ provider }),
  });
}
