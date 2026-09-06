// 基础设施层·日用量统计模块（写回式 UsageStore）。
// 职责：把"每次调用/结果的记账"先在内存累积，再按节流策略合并写回 D1；
// 对外提供"统计"读契约（小时桶 SUM，今日边界由调用方给定 minHour）。
// 精度契约（近似值）：同一实例内 record* 后立即 Read 可见（本实例增量叠加）；
// 跨实例最多延迟一个 flush 间隔；isolate 被回收时未 flush 的增量丢失（≤ 一间隔量）。
// flush 写失败静默，读失败按 0 处理，绝不阻塞主流程。
// 用量按 UTC 小时桶落库（usage_counts）；success/fail 二选一，calls = 二者之和（派生）。

import { DistStats, Provider, utcTodayStart } from "./domain";
import { Env } from "./types";
import {
  UsageIncrement,
  mergeUsage,
  readHourly as storeReadHourly,
  readSeriesByProvider as storeReadSeriesByProvider,
  sumUsageByScopes,
} from "./storage/usage";

type Result = "success" | "fail";

export interface UsageStore {
  /** 记一次上游结果（成功/失败）——纯内存累加，0 IO。 */
  recordUpstreamResult(id: string, provider: Provider, hour: string, result: Result): void;
  /** 记一次分发 key 请求（success/fail 二元，不区分后端/协议）——纯内存累加，0 IO。 */
  recordDistCall(apiKey: string, hour: string, outcome: Result): void;
  /** 批量读上游 key 某 UTC 日（minHour 起）统计（展示用，admin 列表页）：D1 现值 + 本实例增量叠加。 */
  readUpstreamTodayStats(
    ids: string[],
    minHour: string
  ): Promise<Record<string, { success: number; fail: number }>>;
  /** 热路径选 key 信号：今日失败数快照（后台刷新）+ 本实例 pending——0 次 D1 往返。 */
  readUpstreamWeightSignal(ids: string[]): Promise<Record<string, number>>;
  /** 批量读多个分发 key 某 UTC 日统计（展示用）：D1 现值 + 本实例增量叠加。 */
  readDistCallsByScopes(
    apiKeys: string[],
    minHour: string
  ): Promise<Record<string, DistStats>>;
  /** 读某 scope 的小时明细（给前端组合"今日/最近N小时"边界用）。 */
  readHourly(kind: "upstream" | "dist", scope: string, minHour: string): Promise<UsageIncrement[]>;
  /** 读上游真实调用尝试小时序列（Memory TTL + pending 叠加）；给 dashboard 近5天趋势图。 */
  readUpstreamSeries(minHour: string): Promise<UpstreamSeriesPoint[]>;
  /** 读全部分发 key 的 dist 小时序列（Memory TTL + pending 叠加）；给 dashboard 24h/昨日卡。 */
  readDistSeries(minHour: string): Promise<DistSeriesPoint[]>;
  /** 节流调度 flush：距上次 ≥interval 且缓冲非空才排入 waitUntil，不阻塞请求。 */
  flushSoon(ctx: { waitUntil(p: Promise<unknown>): void }): void;
}

/** dist 行 provider 列哨兵值：schema 中 provider 列 NOT NULL 且入 PK，dist 不区分后端统一写该值；dist 读路径无视其值。 */
export const DIST_PROVIDER = "*";

/**
 * dashboard 近5天趋势图单个数据点：某 UTC 小时桶 × provider 的上游真实调用尝试次数（success+fail）。
 * 刻意固化为 tavily/exa 两个字段（计划审批"两条线"展示，见 docs/architecture.md §4.2 已知例外）。
 * 新增 provider 时须同步扩展：本类型、readUpstreamSeries 内两处 provider 折叠、views/index.ts dashboardScript。
 */
export interface UpstreamSeriesPoint {
  hour: string;
  tavily: number;
  exa: number;
}

/** dashboard 24h/昨日卡用的 dist 小时序列点：calls = 该小时桶跨全部 provider 的 success+fail 合计。 */
export interface DistSeriesPoint {
  hour: string;
  calls: number;
}

export interface UsageStoreOpts {
  flushIntervalMs?: number;
  readCacheMs?: number;
  /** 后台统计信号快照最大陈旧时长；默认 120s，测试可缩短窗口。 */
  signalBaseTtlMs?: number;
  /** 跨 scope 小时序列缓存 TTL；默认 30min（每 isolate 每小时 ≤2 次历史读）。 */
  seriesTtlMs?: number;
}

const bufKey = (r: Pick<UsageIncrement, "kind" | "scope" | "provider" | "hour">) =>
  `${r.kind}\u0000${r.scope}\u0000${r.provider}\u0000${r.hour}`;

export function createUsageStore(env: Env, opts: UsageStoreOpts = {}): UsageStore {
  const flushIntervalMs = opts.flushIntervalMs ?? 5_000;
  const readCacheMs = opts.readCacheMs ?? 30_000;
  const signalBaseTtlMs = opts.signalBaseTtlMs ?? 120_000;
  const seriesTtlMs = opts.seriesTtlMs ?? 1_800_000;

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
  let distCache: {
    ids: string;
    minHour: string;
    at: number;
    base: Record<string, DistStats>;
  } | null = null;
  // 跨 scope 小时序列 base（D1 聚合结果），读时叠加 pending；TTL seriesTtlMs。
  // upstream 与 dist 各自独立缓存（同 TTL，读时按需填充）。
  let upstreamSeriesCache: { minHour: string; at: number; base: UpstreamSeriesPoint[] } | null = null;
  let distSeriesCache: { minHour: string; at: number; base: DistSeriesPoint[] } | null = null;
  // 热路径选 key 信号：今日失败数快照，由 flush 后台刷新，最长陈旧 signalBaseTtlMs。
  let signalBase: { minHour: string; at: number; fail: Record<string, number> } | null = null;

  /** 惰性刷新信号快照：空 base / 跨天 / 超 TTL 才查询；失败由调用方吞掉，保留旧 base。 */
  async function maybeRefreshSignalBase(): Promise<void> {
    const minHour = utcTodayStart();
    const now = Date.now();
    if (signalBase && signalBase.minHour === minHour && now - signalBase.at < signalBaseTtlMs) return;
    const { results } = await env.DB.prepare(
      `SELECT scope, COALESCE(SUM(fail),0) AS fail
       FROM usage_counts WHERE kind = ?1 AND hour >= ?2 GROUP BY scope`
    ).bind("upstream", minHour).all();
    const fail: Record<string, number> = {};
    for (const r of results as Record<string, unknown>[]) fail[r.scope as string] = (r.fail as number) ?? 0;
    signalBase = { minHour, at: now, fail };
  }

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
      // flush 已跑在 waitUntil（后台）：顺带刷新信号快照，不阻塞请求。
      await maybeRefreshSignalBase().catch(() => {});
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

  function recordDistCall(apiKey: string, hour: string, outcome: Result): void {
    const key = bufKey({ kind: "dist", scope: apiKey, provider: DIST_PROVIDER, hour });
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
      const byScope = await sumUsageByScopes(env, "upstream", ids, minHour);
      for (const id of ids) {
        const byProvider = byScope[id] ?? {};
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

  /** 热路径选 key 信号：今日失败数快照（后台刷新）+ 本实例 pending；0 次 D1 往返。 */
  async function readUpstreamWeightSignal(ids: string[]): Promise<Record<string, number>> {
    if (ids.length === 0) return {};
    const minHour = utcTodayStart();
    const out: Record<string, number> = {};
    for (const id of ids) {
      let f = signalBase && signalBase.minHour === minHour ? (signalBase.fail[id] ?? 0) : 0;
      for (const [k, v] of pending) {
        if (k.startsWith("upstream\u0000" + id + "\u0000")) f += v.fail;
      }
      out[id] = f;
    }
    return out;
  }

  async function readDistCallsByScopes(
    apiKeys: string[],
    minHour: string
  ): Promise<Record<string, DistStats>> {
    if (apiKeys.length === 0) return {};
    const idsKey = [...apiKeys].sort().join(",");
    const now = Date.now();
    if (
      !distCache ||
      distCache.ids !== idsKey ||
      distCache.minHour !== minHour ||
      now - distCache.at >= readCacheMs
    ) {
      const base: Record<string, DistStats> = {};
      const byScope = await sumUsageByScopes(env, "dist", apiKeys, minHour);
      for (const key of apiKeys) {
        // 汇总该 scope 全部 provider 的 success/fail；缺失 provider 不产生计数。
        let success = 0;
        let fail = 0;
        for (const w of Object.values(byScope[key] ?? {})) {
          success += w.success;
          fail += w.fail;
        }
        base[key] = { success, fail };
      }
      distCache = { ids: idsKey, minHour, at: now, base };
    }
    // 近似口径：pending 中该 scope 的全部小时增量并入（无视 provider 值）。
    const result: Record<string, DistStats> = {};
    for (const key of apiKeys) {
      const b = distCache.base[key] ?? { success: 0, fail: 0 };
      const approx = { success: 0, fail: 0 };
      for (const [k, v] of pending) {
        if (k.startsWith("dist\u0000" + key + "\u0000")) {
          approx.success += v.success;
          approx.fail += v.fail;
        }
      }
      result[key] = { success: b.success + approx.success, fail: b.fail + approx.fail };
    }
    return result;
  }

  async function readHourly(
    kind: "upstream" | "dist",
    scope: string,
    minHour: string
  ): Promise<UsageIncrement[]> {
    return storeReadHourly(env, kind, scope, minHour);
  }

  /**
   * 全部分发 key 的上游真实调用尝试序列（D1 base + pending 叠加；TTL seriesTtlMs）。
   * 下方两处 `if (provider === ...)` 折叠（D1 base 与 pending）按 provider 名硬编码 tavily/exa，
   * 属 docs/architecture.md §4.2 的已知例外：新增 provider 时须扩展 UpstreamSeriesPoint、
   * 本函数两处折叠与 views/index.ts dashboardScript（dist 序列无须参与）。
   */
  async function readUpstreamSeries(minHour: string): Promise<UpstreamSeriesPoint[]> {
    const now = Date.now();
    if (
      !upstreamSeriesCache ||
      upstreamSeriesCache.minHour !== minHour ||
      now - upstreamSeriesCache.at >= seriesTtlMs
    ) {
      const rows = await storeReadSeriesByProvider(env, "upstream", minHour);
      const byHour = new Map<string, { tavily: number; exa: number }>();
      for (const r of rows) {
        const cur = byHour.get(r.hour) ?? { tavily: 0, exa: 0 };
        const calls = r.success + r.fail;
        if (r.provider === "tavily") cur.tavily += calls;
        else if (r.provider === "exa") cur.exa += calls;
        byHour.set(r.hour, cur);
      }
      upstreamSeriesCache = {
        minHour,
        at: now,
        base: [...byHour.entries()]
          .map(([hour, v]) => ({ hour, tavily: v.tavily, exa: v.exa }))
          .sort((a, b) => (a.hour < b.hour ? -1 : b.hour < a.hour ? 1 : 0)),
      };
    }
    const result: UpstreamSeriesPoint[] = upstreamSeriesCache.base.map((p) => ({ ...p }));
    const idx = new Map(result.map((p, i) => [p.hour, i]));
    // pending 叠加：仅 upstream 且 hour >= minHour（pending 小时桶可能不在 D1 base 里，兜底 0）。
    for (const [k, v] of pending) {
      const [kind, , provider, hour] = k.split("\u0000");
      if (kind !== "upstream" || hour < minHour) continue;
      let entry = result[idx.get(hour) ?? -1];
      if (!entry) {
        entry = { hour, tavily: 0, exa: 0 };
        idx.set(hour, result.length);
        result.push(entry);
      }
      const calls = v.success + v.fail;
      if (provider === "tavily") entry.tavily += calls;
      else if (provider === "exa") entry.exa += calls;
    }
    result.sort((a, b) => (a.hour < b.hour ? -1 : b.hour < a.hour ? 1 : 0));
    return result;
  }

  /**
   * 全部分发 key 的 dist 小时序列（D1 base + pending 叠加；TTL seriesTtlMs）。
   * calls = 该小时桶跨全部 provider 的 success+fail 合计（不落入 provider 维度）。
   */
  async function readDistSeries(minHour: string): Promise<DistSeriesPoint[]> {
    const now = Date.now();
    if (
      !distSeriesCache ||
      distSeriesCache.minHour !== minHour ||
      now - distSeriesCache.at >= seriesTtlMs
    ) {
      const rows = await storeReadSeriesByProvider(env, "dist", minHour);
      const byHour = new Map<string, number>();
      for (const r of rows) {
        byHour.set(r.hour, (byHour.get(r.hour) ?? 0) + r.success + r.fail);
      }
      distSeriesCache = {
        minHour,
        at: now,
        base: [...byHour.entries()]
          .map(([hour, calls]) => ({ hour, calls }))
          .sort((a, b) => (a.hour < b.hour ? -1 : b.hour < a.hour ? 1 : 0)),
      };
    }
    const result: DistSeriesPoint[] = distSeriesCache.base.map((p) => ({ ...p }));
    const idx = new Map(result.map((p, i) => [p.hour, i]));
    // pending 叠加：仅 dist 且 hour >= minHour，无视 provider 值（pending 小时桶可能不在 D1 base 里，兜底 0）。
    for (const [k, v] of pending) {
      const [kind, , , hour] = k.split("\u0000");
      if (kind !== "dist" || hour < minHour) continue;
      let entry = result[idx.get(hour) ?? -1];
      if (!entry) {
        entry = { hour, calls: 0 };
        idx.set(hour, result.length);
        result.push(entry);
      }
      entry.calls += v.success + v.fail;
    }
    result.sort((a, b) => (a.hour < b.hour ? -1 : b.hour < a.hour ? 1 : 0));
    return result;
  }

  return {
    recordUpstreamResult,
    recordDistCall,
    readUpstreamTodayStats,
    readUpstreamWeightSignal,
    readDistCallsByScopes,
    readHourly,
    readUpstreamSeries,
    readDistSeries,
    flushSoon,
  };
}

// ---- 每 isolate 一份的默认实例（proxy 与 admin 复用同一实现/同一 pending）----
let defaultStore: UsageStore | null = null;

export function getUsageStore(env: Env): UsageStore {
  if (!defaultStore) defaultStore = createUsageStore(env);
  return defaultStore;
}
