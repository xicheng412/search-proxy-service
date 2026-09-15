// 基础设施层·日用量统计模块的"组合根 + 门面 + 单例"（原 usage-store.ts 的装配层）。
// 写堡垒（core.ts：pending 缓冲 + flush 管道 + 键契约 × 1）与三类读产品
// （reads/today.ts 管理页当日、reads/weight.ts 权重信号、reads/series.ts dashboard 序列）
// 在此组合成对外不变的 UsageStore 门面；getUsageStore 每 isolate 一份默认实例。
// 所有方法引用皆为闭包（无 this），直接传引用安全。

import type { Env } from "../types";
import type { DistStats, Provider } from "../domain";
import type { UsageIncrement } from "../storage/usage";
import { createCore } from "./core";
import { makeTodayRead } from "./reads/today";
import { makeWeightSignal } from "./reads/weight";
import { makeSeriesRead } from "./reads/series";
import type { UpstreamSeriesPoint, DistSeriesPoint } from "./reads/series";

// 保持序列点类型面向外可达（现状本就在原 usage-store.ts 公开导出）。
export type { UpstreamSeriesPoint, DistSeriesPoint };

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
  /** 节流调度 flush：距上次 ≥interval 且未达条数上限才排入 waitUntil，不阻塞请求。 */
  flushSoon(ctx: { waitUntil(p: Promise<unknown>): void }): void;
  /** 立即落库缓冲中全部增量（队列清空兜底用）：复用 flush 的防重入与批量合并，不改节流时钟。 */
  flushNow(): Promise<void>;
  /** 立即刷新权重信号 base（空 base / 窗口下界变化 / 超 TTL 才查 D1，否则 0 IO no-op）。 */
  refreshWeightBase(): Promise<void>;
}

export interface UsageStoreOpts {
  /** 小时桶大致统计落库节流：距上次 flush 不足此间隔且未达条数阈值则不写。默认 30min（≥30min 落库，不追求实时）。 */
  flushIntervalMs?: number;
  /** 单 isolate 缓冲（pending）条数上限；达到即强制 flush，防长驻 isolate 无界增长。默认 256。 */
  flushMaxPending?: number;
  readCacheMs?: number;
  /** 后台统计信号快照最大陈旧时长；默认 120s，测试可缩短窗口。 */
  signalBaseTtlMs?: number;
  /** 权重信号滑动窗口（ms）；只影响热路径选 key 的信号，不影响展示口径。默认 30min。 */
  weightWindowMs?: number;
  /** 跨 scope 小时序列缓存 TTL；默认 30min（每 isolate 每小时 ≤2 次历史读）。 */
  seriesTtlMs?: number;
}

export function createUsageStore(env: Env, opts: UsageStoreOpts = {}): UsageStore {
  const core = createCore(env, {
    flushIntervalMs: opts.flushIntervalMs,
    flushMaxPending: opts.flushMaxPending,
  });
  const today = makeTodayRead(env, core, { readCacheMs: opts.readCacheMs });
  const weight = makeWeightSignal(env, core, {
    signalBaseTtlMs: opts.signalBaseTtlMs,
    weightWindowMs: opts.weightWindowMs,
  });
  const series = makeSeriesRead(env, core, { seriesTtlMs: opts.seriesTtlMs });
  // flush 落库后后台刷新权重信号快照（flush 已跑在 waitUntil，不阻塞请求；失败静默）。
  core.onFlushed(() => weight.refreshNow().catch(() => {}));
  return {
    recordUpstreamResult: core.recordUpstreamResult,
    recordDistCall: core.recordDistCall,
    flushSoon: core.flushSoon,
    flushNow: core.flushNow,
    readUpstreamTodayStats: today.upstreamToday,
    readDistCallsByScopes: today.distToday,
    readHourly: today.hourly,
    readUpstreamWeightSignal: weight.readSignal,
    refreshWeightBase: () => weight.refreshNow().catch(() => {}),
    readUpstreamSeries: series.upstream,
    readDistSeries: series.dist,
  };
}

// ---- 每 isolate 一份的默认实例（proxy 与 admin 复用同一实现/同一 pending）----
let defaultStore: UsageStore | null = null;

export function getUsageStore(env: Env): UsageStore {
  if (!defaultStore) defaultStore = createUsageStore(env);
  return defaultStore;
}
