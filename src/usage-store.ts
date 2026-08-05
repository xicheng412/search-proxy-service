// 基础设施层·日用量统计模块（写回式 UsageStore）。
// 职责：把"每次调用/结果的记账"先在内存累积，再按节流策略合并写回存储；
// 对外提供"今日统计"的统一读契约（KV 现值 + 本实例未 flush 增量）。
// 它自带业务逻辑（累积、节流、合并、读缓存、保留 TTL），
// 依赖 storage.ts 的纯读写原语；domain 类型（Provider/DistStats）只作词汇。
//
// 精度契约（近似值）：
//   同一实例内 record* 后立即 Read 可见（本实例增量叠加）；
//   跨实例最多延迟一个 flush 间隔；isolate 被回收时未 flush 的增量丢失（≤ 一间隔量）。
//   flush 写失败静默，读失败按 0 处理，绝不阻塞主流程。

import { DistStats, Provider } from "./domain";
import {
  distStatsKey,
  readValueStats,
  statsKey,
  writeValueStats,
} from "./storage";

export interface UsageStore {
  /** 记一次上游结果（成功/失败）——纯内存累加，0 IO。 */
  recordUpstreamResult(id: string, result: "success" | "fail", date: string): void;
  /** 记一次分发 key 调用（按 provider 拆分）——纯内存累加，0 IO。 */
  recordDistCall(apiKey: string, provider: Provider, date: string): void;
  /** 批量读上游 key 当日统计（选 key 权重用）：KV 值缓存 + 本实例增量叠加。 */
  readUpstreamTodayStats(
    ids: string[],
    date: string
  ): Promise<Record<string, { success: number; fail: number }>>;
  /** 读分发 key 当日调用（展示用）：KV 现值 + 本实例增量叠加。 */
  readDistCalls(apiKey: string, date: string): Promise<DistStats>;
  /** 节流调度 flush：距上次 ≥interval 且缓冲非空才排入 waitUntil，不阻塞请求。 */
  flushSoon(ctx: { waitUntil(p: Promise<unknown>): void }): void;
}

export interface UsageStoreOpts {
  flushIntervalMs?: number;
  retentionDays?: number;
  readCacheMs?: number;
}

const COUNTER_FIELDS = ["success", "fail", "tavily", "exa"] as const;

export function createUsageStore(kv: KVNamespace, opts: UsageStoreOpts = {}): UsageStore {
  const flushIntervalMs = opts.flushIntervalMs ?? 5_000;
  const retentionSeconds = (opts.retentionDays ?? 10) * 86_400;
  const readCacheMs = opts.readCacheMs ?? 30_000;

  // ---- 模块状态（每个 store 实例独立；一个 isolate 一份）----
  const pending = new Map<string, Record<string, number>>();
  let lastFlushAt = 0;
  let flushing = false;
  let weightCache: {
    ids: string;
    date: string;
    at: number;
    base: Record<string, { success: number; fail: number }>;
  } | null = null;

  function addPending(key: string, delta: Record<string, number>): void {
    const cur = pending.get(key) ?? {};
    const next: Record<string, number> = { ...cur };
    for (const [field, v] of Object.entries(delta)) next[field] = (cur[field] ?? 0) + v;
    pending.set(key, next);
  }

  async function flush(): Promise<void> {
    if (flushing || pending.size === 0) return;
    flushing = true;
    // 先同步快照并清空再异步写：单线程下不漏计/不重计，期间新增量进下一轮。
    const batch = new Map(pending);
    pending.clear();
    try {
      await Promise.all(
        [...batch.entries()].map(async ([key, delta]) => {
          const cur = await readValueStats(kv, key);
          const merged: Record<string, number> = { ...cur };
          for (const field of COUNTER_FIELDS) {
            const sum = (cur[field] ?? 0) + (delta[field] ?? 0);
            if (sum !== 0) merged[field] = sum;
            else delete merged[field];
          }
          if (Object.keys(merged).length === 0) return;
          try {
            await writeValueStats(kv, key, merged, retentionSeconds);
          } catch {
            // 写失败静默：统计不阻塞主流程
          }
        })
      );
    } finally {
      flushing = false;
    }
  }

  function flushSoon(ctx: { waitUntil(p: Promise<unknown>): void }): void {
    if (pending.size === 0) return;
    const now = Date.now();
    if (now - lastFlushAt < flushIntervalMs) return;
    lastFlushAt = now;
    ctx.waitUntil(flush().catch(() => {}));
  }

  function recordUpstreamResult(id: string, result: "success" | "fail", date: string): void {
    addPending(statsKey(id, date), result === "success" ? { success: 1 } : { fail: 1 });
  }

  function recordDistCall(apiKey: string, provider: Provider, date: string): void {
    addPending(distStatsKey(apiKey, date), provider === "exa" ? { exa: 1 } : { tavily: 1 });
  }

  async function readUpstreamTodayStats(
    ids: string[],
    date: string
  ): Promise<Record<string, { success: number; fail: number }>> {
    const idsKey = [...ids].sort().join(",");
    const now = Date.now();
    if (
      !weightCache ||
      weightCache.ids !== idsKey ||
      weightCache.date !== date ||
      now - weightCache.at >= readCacheMs
    ) {
      const base: Record<string, { success: number; fail: number }> = {};
      await Promise.all(
        ids.map(async (id) => {
          const v = await readValueStats(kv, statsKey(id, date));
          base[id] = { success: v.success ?? 0, fail: v.fail ?? 0 };
        })
      );
      weightCache = { ids: idsKey, date, at: now, base };
    }
    const result: Record<string, { success: number; fail: number }> = {};
    for (const id of ids) {
      const b = weightCache.base[id] ?? { success: 0, fail: 0 };
      const loc = pending.get(statsKey(id, date)) ?? {};
      result[id] = {
        success: b.success + (loc.success ?? 0),
        fail: b.fail + (loc.fail ?? 0),
      };
    }
    return result;
  }

  async function readDistCalls(apiKey: string, date: string): Promise<DistStats> {
    const key = distStatsKey(apiKey, date);
    const v = await readValueStats(kv, key);
    const loc = pending.get(key) ?? {};
    return {
      tavily: (v.tavily ?? 0) + (loc.tavily ?? 0),
      exa: (v.exa ?? 0) + (loc.exa ?? 0),
    };
  }

  return {
    recordUpstreamResult,
    recordDistCall,
    readUpstreamTodayStats,
    readDistCalls,
    flushSoon,
  };
}

// ---- 每 isolate 一份的默认实例（proxy 与 admin 复用同一实现/同一 pending）----
let defaultStore: UsageStore | null = null;

export function getUsageStore(kv: KVNamespace): UsageStore {
  if (!defaultStore) defaultStore = createUsageStore(kv);
  return defaultStore;
}
