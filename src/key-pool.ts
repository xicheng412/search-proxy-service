// 基础设施层·上游 key 池内存权威态（KeyPool）。
// 每 provider 一把，由该 provider 的 QueueDO（durable-object.ts）持有；同一进程单点写者：
//   - 冷却（cooldown_until）与熔断连续计数（breaker: Map）只在本池内存被改，
//     选 key（domain-services/retry-state-machine.ts emit(init) 读 pool.getKeys()）读到的就是刚写入的值——强一致。
//   - D1 仅是低频 checkpoint 备份：checkpointCooldowns 批量写回 cooldown_until。
//     丢失方向安全：冷却丢 = 提前放行、熔断计数丢 = 重新计数，均为放宽非锁死。
//   - D1 对 id/key/name/status/created_at 仍权威（admin 写），本池经 reload 合并采纳。
// admin 写 D1 后经 notifyKeyPoolSync 推式全量重读（worker → DO /_internal/sync-keys），
// 另有 RELOAD_FLOOR_MS 陈旧兜底重读（drain 每任务前 maybeReload）。
// checkpoint 失败静默（保留 dirty 下轮重试），复用 usage-store 的静默风格，不阻塞主流程。

import type { Env } from "./types";
import type { UpstreamDef, CoreKey, CooldownCause, Provider } from "./domain";
import type { BreakerState } from "./domain-services/breaker-policy";
import { listUpstreamKeys, checkpointCooldowns } from "./storage/upstream-keys";

export interface KeyPool {
  /** 返回当前内部数组；元素对象被 applyBreakerOutcome 原地改（选 key 即刻可见最新冷却）。 */
  getKeys(): CoreKey[];
  getBreakerState(id: string): BreakerState | null;
  /** 原地写某次上游结果的 cooldown + cause + 可选熔断计数，并标记 dirty（待 checkpoint）。 */
  applyBreakerOutcome(id: string, cooldownUntil: number, cause: CooldownCause, consecutive: number | null, now: number): void;
  /** admin 启用：清掉机器冷却（cooldown_until 与 suspended_cause），该 key 立即可选。 */
  activate(id: string): void;
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
  const breaker = new Map<string, BreakerState>();
  const dirty = new Set<string>();
  let loaded = seed !== undefined;
  let loadedAt = seed !== undefined ? Date.now() : 0;
  let lastCheckpointAt = 0;
  let reloading: Promise<void> | null = null;
  let checkpointing = false;

  function applyBreakerOutcome(
    id: string,
    cooldownUntil: number,
    cause: CooldownCause,
    consecutive: number | null,
    now: number
  ): void {
    const key = keys.find((k) => k.id === id);
    if (!key) return; // 已删 key 竞态：不建脏条目
    // 原地改：retry 的 ctx.keys 快照即刻可见最新冷却（强一致的关键）
    key.cooldown_until = cooldownUntil;
    key.suspended_cause = cause;
    if (consecutive !== null) {
      breaker.set(id, {
        consecutive,
        updated_at: now,
        created_at: breaker.get(id)?.created_at ?? now,
      });
    }
    dirty.add(id);
  }

  /** 清掉机器冷却（cooldown 与 cause），供 admin 启用时立即可选。不碰熔断计数。 */
  function activate(id: string): void {
    const key = keys.find((k) => k.id === id);
    if (!key) return;
    key.cooldown_until = null;
    key.suspended_cause = null;
    dirty.add(id);
  }

  async function reload(): Promise<void> {
    // 读发起前的 dirty 快照：本次读可能与在途 checkpoint 并发——D1 可能返回提交前的旧值，
    // 而 checkpoint 的后续清理又已把该 id 移出 dirty；只看读发起后的 dirty 会采纳旧冷却。
    const dirtyBeforeRead = new Set(dirty);
    const rows = await listUpstreamKeys(env, def);
    const byId = new Map(rows.map((r) => [r.id, r]));
    const old = new Map(keys.map((k) => [k.id, k]));
    // 合并重建：id 已在旧内存 → 复用同一对象，采纳 D1 的 name/status（admin 写后需生效）。
    // 冷却/因由的取舍按 dirty 判定：
    //   - dirty：内存有尚未 checkpoint 的新冷却，必须保留，否则会提前放行；
    //   - 非 dirty：D1 就是最新快照，采纳它（含 admin 启用写入的 NULL），
    //     使 activate 推送失败也能在 60s 陈旧兜底重读时自愈。
    keys = rows.map((row) => {
      const existing = old.get(row.id);
      if (existing) {
        existing.name = row.name;
        existing.status = row.status;
        if (!dirtyBeforeRead.has(row.id) && !dirty.has(row.id)) {
          existing.cooldown_until = row.cooldown_until;
          existing.suspended_cause = row.suspended_cause;
        }
        return existing;
      }
      return { ...row };
    });
    // 熔断计数与 dirty 都只保留仍存在的 id（已删 key 的冷却不再有落库目标）。
    for (const id of breaker.keys()) {
      if (!byId.has(id)) breaker.delete(id);
    }
    for (const id of dirty) {
      if (!byId.has(id)) dirty.delete(id);
    }
    loaded = true;
    loadedAt = Date.now();
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
      const entries: { id: string; cooldown_until: number | null; suspended_cause: CooldownCause | null }[] = [];
      for (const id of dirty) {
        const k = keys.find((candidate) => candidate.id === id);
        if (!k) {
          dirty.delete(id); // 已删 key：不再有落库目标
          continue;
        }
        entries.push({ id: k.id, cooldown_until: k.cooldown_until, suspended_cause: k.suspended_cause });
      }
      if (entries.length === 0) {
        lastCheckpointAt = Date.now();
        return;
      }
      await checkpointCooldowns(env, def, entries);
      // 只清「写完后仍与快照一致」的 dirty：await 期间可能又发生了新失败/activate，
      // 那些更新的值必须留在 dirty 里等下一轮写回。
      const currentById = new Map(keys.map((k) => [k.id, k]));
      for (const e of entries) {
        const current = currentById.get(e.id);
        if (!current) {
          dirty.delete(e.id);
          continue;
        }
        if (
          current.cooldown_until === e.cooldown_until &&
          current.suspended_cause === e.suspended_cause
        ) {
          dirty.delete(e.id);
        }
      }
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
    activate,
    maybeReload,
    reload,
    maybeCheckpoint,
    flushNow,
  };
}

/**
 * 领域语义词典（命令 → KeyPoolSync 推式同步端口 → 订阅者）：
 *   Add / AddBatch / Rename / Toggle / ToggleBatch / Delete / DeleteBatch
 *   （admin 写 D1，tavily.ts / exa.ts 各 7 处、共 14 处调用点）
 *     → UpstreamKeyChanged（KeyPoolSync 推式同步端口，非领域事件；语义名，
 *       未显式建模，经本函数推送到 DO）
 *     → 订阅者 KeyPool.reload（QueueDO `/_internal/sync-keys` 全量重读合并）
 * 本函数即该语义的收口辅助：任何 upstream key 写操作在持久化（D1）后经它同步内存池。
 * 失败重试一次；仍失败则抛出，由调用方决定是否提示（60s 陈旧重读只是兜底，不是同步成功）。
 */
export async function notifyKeyPoolSync(env: Env, provider: Provider): Promise<void> {
  await postQueueInternal(env, provider, "/_internal/sync-keys", { provider });
}

/**
 * admin 启用某 key 后推送：经 DO `/_internal/activate` 清掉该 key 的内存冷却
 * （cooldown 与 suspended_cause），令其立即可选。内存对 cooldown 是权威，reload 仅在
 * 该 id 非 dirty 时采纳 D1，故启用要先清内存，再由 notifyKeyPoolSync 全量合并采纳 status。
 * 失败重试一次；仍失败则抛出，由 admin 路由提示。即使推送彻底失败，reload 在无 dirty
 * 时会采纳 D1 的 NULL 冷却，60s 内自愈。
 */
export async function notifyKeyPoolActivate(env: Env, provider: Provider, id: string): Promise<void> {
  await postQueueInternal(env, provider, "/_internal/activate", { provider, id });
}

/** 推送内部同步命令：失败重试一次，仍失败抛出（调用方决定提示）。 */
async function postQueueInternal(
  env: Env,
  provider: Provider,
  path: string,
  body: Record<string, string>
): Promise<void> {
  const stub = env.QUEUE.get(env.QUEUE.idFromName(provider));
  let lastError: unknown;
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const res = await stub.fetch(`https://queue.internal${path}`, {
        method: "POST",
        body: JSON.stringify(body),
      });
      if (res.ok) return;
      lastError = new Error(`queue internal ${path} failed: HTTP ${res.status}`);
    } catch (err) {
      lastError = err;
    }
    if (attempt === 0) {
      // Workers 的 tsconfig lib 未声明 Promise.withResolvers；这里只需要一次固定退避。
      await new Promise<void>((resolve) => setTimeout(resolve, 100));
    }
  }
  throw lastError;
}
