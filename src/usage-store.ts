// 基础设施层·日用量统计模块（写回式 UsageStore）。
// 职责：把"每次调用/结果的记账"先在内存累积，再按节流策略合并写回 D1；
// 对外提供"统计"读契约（小时桶 SUM，今日边界由调用方给定 minHour）。
// 精度契约（近似值）：同一实例内 record* 后立即 Read 可见（本实例增量叠加）；
// 跨实例最多延迟一个 flush 间隔；isolate 被回收时未 flush 的增量丢失（≤ 一间隔量）。
// flush 写失败静默，读失败按 0 处理，绝不阻塞主流程。
// 用量按 UTC 小时桶落库（usage_counts）；success/fail 二选一，calls = 二者之和（派生）。

import { DistStats, Provider } from "./domain";
import { Env } from "./types";
import {
  UsageIncrement,
  mergeUsage,
  readHourly as storeReadHourly,
  sumUsageByProvider,
} from "./storage";

type Result = "success" | "fail";

export interface UsageStore {
  /** 记一次上游结果（成功/失败）——纯内存累加，0 IO。 */
  recordUpstreamResult(id: string, provider: Provider, hour: string, result: Result): void;
  /** 记一次分发 key 调用（按 provider + 结果拆分）——纯内存累加，0 IO。 */
  recordDistCall(apiKey: string, provider: Provider, hour: string, outcome: Result): void;
  /** 批量读上游 key 某 UTC 日（minHour 起）统计（选 key 权重用）：D1 现值 + 本实例增量叠加。 */
  readUpstreamTodayStats(
    ids: string[],
    minHour: string
  ): Promise<Record<string, { success: number; fail: number }>>;
  /** 读分发 key 某 UTC 日统计（展示用）：D1 现值 + 本实例增量叠加。 */
  readDistCalls(apiKey: string, minHour: string): Promise<DistStats>;
  /** 读某 scope 的小时明细（给前端组合"今日/最近N小时"边界用）。 */
  readHourly(kind: "upstream" | "dist", scope: string, minHour: string): Promise<UsageIncrement[]>;
  /** 节流调度 flush：距上次 ≥interval 且缓冲非空才排入 waitUntil，不阻塞请求。 */
  flushSoon(ctx: { waitUntil(p: Promise<unknown>): void }): void;
}

export interface UsageStoreOpts {
  flushIntervalMs?: number;
  readCacheMs?: number;
}

const bufKey = (r: Pick<UsageIncrement, "kind" | "scope" | "provider" | "hour">) =>
  `${r.kind}\u0000${r.scope}\u0000${r.provider}\u0000${r.hour}`;

export function createUsageStore(env: Env, opts: UsageStoreOpts = {}): UsageStore {
  const flushIntervalMs = opts.flushIntervalMs ?? 5_000;
  const readCacheMs = opts.readCacheMs ?? 30_000;

  // ---- 模块状态（每个 store 实例独立；一个 isolate 一份）----
  const pending = new Map<string, { success: number; fail: number }>();
  let lastFlushAt = 0;
  let flushing = false;
  let weightCache: {
    ids: string;
    minHour: string;
    at: number;
    base: Record<string, { success: number; fail: number }>;
  } | null = null;

  async function flush(): Promise<void> {
    if (flushing || pending.size === 0) return;
    flushing = true;
    const batch = new Map(pending);
    pending.clear();
    try {
      const rows: UsageIncrement[] = [];
      for (const [key, v] of batch) {
        const [kind, scope, provider, hour] = key.split("\u0000");
        rows.push({
          kind: kind as UsageIncrement["kind"],
          scope,
          provider,
          hour,
          success: v.success,
          fail: v.fail,
        });
      }
      await mergeUsage(env, rows);
    } catch {
      // 写失败静默：统计不阻塞主流程
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

  function recordUpstreamResult(
    id: string,
    provider: Provider,
    hour: string,
    result: Result
  ): void {
    const key = bufKey({ kind: "upstream", scope: id, provider, hour });
    const cur = pending.get(key) ?? { success: 0, fail: 0 };
    if (result === "success") cur.success += 1;
    else cur.fail += 1;
    pending.set(key, cur);
  }

  function recordDistCall(
    apiKey: string,
    provider: Provider,
    hour: string,
    outcome: Result
  ): void {
    const key = bufKey({ kind: "dist", scope: apiKey, provider, hour });
    const cur = pending.get(key) ?? { success: 0, fail: 0 };
    if (outcome === "success") cur.success += 1;
    else cur.fail += 1;
    pending.set(key, cur);
  }

  async function readUpstreamTodayStats(
    ids: string[],
    minHour: string
  ): Promise<Record<string, { success: number; fail: number }>> {
    const idsKey = [...ids].sort().join(",");
    const now = Date.now();
    if (
      !weightCache ||
      weightCache.ids !== idsKey ||
      weightCache.minHour !== minHour ||
      now - weightCache.at >= readCacheMs
    ) {
      const base: Record<string, { success: number; fail: number }> = {};
      for (const id of ids) {
        const byProvider = await sumUsageByProvider(env, "upstream", id, minHour);
        let s = 0;
        let f = 0;
        for (const w of Object.values(byProvider)) {
          s += w.success;
          f += w.fail;
        }
        base[id] = { success: s, fail: f };
      }
      weightCache = { ids: idsKey, minHour, at: now, base };
    }
    const result: Record<string, { success: number; fail: number }> = {};
    for (const id of ids) {
      const b = weightCache.base[id] ?? { success: 0, fail: 0 };
      // 近似口径：pending 中该 scope 的全部小时增量并入。
      const approx = { success: 0, fail: 0 };
      for (const [k, v] of pending) {
        if (k.startsWith("upstream\u0000" + id + "\u0000")) {
          approx.success += v.success;
          approx.fail += v.fail;
        }
      }
      result[id] = { success: b.success + approx.success, fail: b.fail + approx.fail };
    }
    return result;
  }

  async function readDistCalls(apiKey: string, minHour: string): Promise<DistStats> {
    const byProvider = await sumUsageByProvider(env, "dist", apiKey, minHour);
    const nowHour = new Date().toISOString().slice(0, 13) + ":00";
    const perProvider = (p: string): number => {
      const d = byProvider[p] ?? { success: 0, fail: 0 };
      const loc = withPending("dist", apiKey, p, nowHour);
      return d.success + d.fail + loc.success + loc.fail;
    };
    return { tavily: perProvider("tavily"), exa: perProvider("exa") };
  }

  function withPending(
    kind: "upstream" | "dist",
    scope: string,
    provider: string,
    hour: string
  ): { success: number; fail: number } {
    return pending.get(bufKey({ kind, scope, provider, hour })) ?? { success: 0, fail: 0 };
  }

  async function readHourly(
    kind: "upstream" | "dist",
    scope: string,
    minHour: string
  ): Promise<UsageIncrement[]> {
    return storeReadHourly(env, kind, scope, minHour);
  }

  return {
    recordUpstreamResult,
    recordDistCall,
    readUpstreamTodayStats,
    readDistCalls,
    readHourly,
    flushSoon,
  };
}

// ---- 每 isolate 一份的默认实例（proxy 与 admin 复用同一实现/同一 pending）----
let defaultStore: UsageStore | null = null;

export function getUsageStore(env: Env): UsageStore {
  if (!defaultStore) defaultStore = createUsageStore(env);
  return defaultStore;
}
