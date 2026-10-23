// 基础设施层·日用量统计的"dashboard 序列"读产品（原 usage-store.ts 的读侧拆出）。
// 全部分发 key 的上游真实调用尝试 / dist 小时序列：D1 base + core pending 叠加；TTL seriesTtlMs。
// 依赖方向只向下：reads/ → core → storage/usage → domain；不 import proxy.ts / admin/*。

import type { Env } from "../../types";
import type { UsageCore } from "../core";
import { readSeriesByProvider as storeReadSeriesByProvider } from "../../storage/usage";
import { BUCKET_MS, bucketKey, utcTodayStart } from "../../domain";

/**
 * dashboard 近5天趋势图单个数据点：某 UTC 时间桶 × provider 的上游真实调用尝试次数（success+fail）。
 * 刻意固化为 tavily/exa 两个字段（计划审批"两条线"展示，见 docs/architecture.md §4.2 已知例外）。
 * 新增 provider 时须同步扩展：本类型、upstream() 内两处 provider 折叠、views/dashboard.ts dashboardScript。
 */
export interface UpstreamSeriesPoint {
  bucket: string;
  tavily: number;
  exa: number;
}

/** dashboard 24h/昨日卡用的 dist 时间序列点：calls = 该时间桶跨全部 provider 的 success+fail 合计。 */
export interface DistSeriesPoint {
  bucket: string;
  calls: number;
}

/** Dashboard 三张卡（最近 24h / 今日 / 昨日）的 dist 汇总，服务质量端口径（避免前端按时区重算）。 */
export interface DistSummaries {
  last24h: number;    // now-24h → now，半开区间
  today: number;      // UTC 今日 00:00 → now
  yesterday: number;  // UTC 昨日 00:00 → UTC 今日 00:00
}

export interface SeriesOpts {
  /** 跨 scope 时间序列缓存 TTL；默认 30min（每 isolate ≤2 次历史读/窗口）。 */
  seriesTtlMs?: number;
}

export function makeSeriesRead(env: Env, core: UsageCore, opts: SeriesOpts = {}) {
  const seriesTtlMs = opts.seriesTtlMs ?? 1_800_000;

  // 跨 scope 时间序列 base（D1 聚合结果），读时叠加 pending；TTL seriesTtlMs。
  // upstream 与 dist 各自独立缓存（同 TTL，读时按需填充）。
  let upstreamSeriesCache: { minBucket: string; at: number; base: UpstreamSeriesPoint[] } | null = null;
  let distSeriesCache: { minBucket: string; at: number; base: DistSeriesPoint[] } | null = null;
  // 在飞去重：同一 minBucket 的 dist base 并发读只发一次 D1（dashboard 同时调 readDistSeries +
  // readDistSummaries，否则冷启动双击空缓存 → 2 次相同查询）。
  let distInflight: { minBucket: string; p: Promise<Map<string, number>> } | null = null;

  // Dashboard 序列契约（2026-09 修复 + 0007 桶 15min）：返回 minBucket..当前桶 完整时间序列，无调用桶补 0。
  // 背景：趋势图用 Chart.js time scale 按真实时间间距渲染 x 轴；此前序列只含「有调用的桶」，
  // 缺失桶无槽位 → 无数据桶被跳过、坐标不等间隔（问题记录见 docs/architecture.md §5.2.2）。
  // 异常范围（minBucket 晚于当前桶 / 解析失败）兜底：原样返回稀疏数组，绝不抛出。
  function fillRange<T extends { bucket: string }>(
    sparse: T[],
    minBucket: string,
    zero: (bucket: string) => T,
  ): T[] {
    const start = Date.parse(minBucket + "Z");
    const end = Date.parse(bucketKey() + "Z");
    if (!isFinite(start) || !isFinite(end) || end < start) return sparse;
    const byBucket = new Map(sparse.map((p) => [p.bucket, p]));
    const out: T[] = [];
    for (let ms = start; ms <= end; ms += BUCKET_MS) {
      const h = bucketKey(ms);
      out.push(byBucket.get(h) ?? zero(h));
    }
    return out;
  }

  /**
   * 全部分发 key 的上游真实调用尝试序列（D1 base + pending 叠加；TTL seriesTtlMs）。
   * 下方两处 `if (provider === ...)` 折叠（D1 base 与 pending）按 provider 名硬编码 tavily/exa，
   * 属 docs/architecture.md §4.2 的已知例外：新增 provider 时须扩展 UpstreamSeriesPoint、
   * 本函数两处折叠与 views/dashboard.ts dashboardScript（dist 序列无须参与）。
   * 返回 `minBucket..当前桶` 完整时间序列，空桶补 0（原因见 `fillRange` 注释）。
   */
  async function upstream(minBucket: string): Promise<UpstreamSeriesPoint[]> {
    const now = Date.now();
    if (
      !upstreamSeriesCache ||
      upstreamSeriesCache.minBucket !== minBucket ||
      now - upstreamSeriesCache.at >= seriesTtlMs
    ) {
      const rows = await storeReadSeriesByProvider(env, "upstream", minBucket);
      const byBucket = new Map<string, { tavily: number; exa: number }>();
      for (const r of rows) {
        const cur = byBucket.get(r.bucket) ?? { tavily: 0, exa: 0 };
        const calls = r.success + r.fail;
        if (r.provider === "tavily") cur.tavily += calls;
        else if (r.provider === "exa") cur.exa += calls;
        byBucket.set(r.bucket, cur);
      }
      upstreamSeriesCache = {
        minBucket,
        at: now,
        base: [...byBucket.entries()]
          .map(([bucket, v]) => ({ bucket, tavily: v.tavily, exa: v.exa }))
          .sort((a, b) => (a.bucket < b.bucket ? -1 : b.bucket < a.bucket ? 1 : 0)),
      };
    }
    const result: UpstreamSeriesPoint[] = upstreamSeriesCache.base.map((p) => ({ ...p }));
    const idx = new Map(result.map((p, i) => [p.bucket, i]));
    // pending 叠加：仅 upstream 且 bucket >= minBucket（pending 桶可能不在 D1 base 里，兜底 0）。
    core.visitPending({ kind: "upstream", minBucket }, (e) => {
      let entry = result[idx.get(e.bucket) ?? -1];
      if (!entry) {
        entry = { bucket: e.bucket, tavily: 0, exa: 0 };
        idx.set(e.bucket, result.length);
        result.push(entry);
      }
      const calls = e.success + e.fail;
      if (e.provider === "tavily") entry.tavily += calls;
      else if (e.provider === "exa") entry.exa += calls;
    });
    result.sort((a, b) => (a.bucket < b.bucket ? -1 : b.bucket < a.bucket ? 1 : 0));
    return fillRange(result, minBucket, (bucket) => ({ bucket, tavily: 0, exa: 0 }));
  }

  /**
   * 全部分发 key 的 dist 时间序列（D1 base + pending 叠加；TTL seriesTtlMs）。
   * calls = 该时间桶跨全部 provider 的 success+fail 合计（不落入 provider 维度）。
   * 返回 `minBucket..当前桶` 完整时间序列，空桶补 0（原因见 `fillRange` 注释）。
   */
  async function dist(minBucket: string): Promise<DistSeriesPoint[]> {
    const now = Date.now();
    if (
      !distSeriesCache ||
      distSeriesCache.minBucket !== minBucket ||
      now - distSeriesCache.at >= seriesTtlMs
    ) {
      // 并发去重：readDistSeries 与 readDistSummaries 同 tick 到达时共享同一次 D1 读。
      const inflight =
        distInflight && distInflight.minBucket === minBucket
          ? distInflight.p
          : (() => {
              const p = storeReadSeriesByProvider(env, "dist", minBucket).then((rows) => {
                const byBucket = new Map<string, number>();
                for (const r of rows) {
                  byBucket.set(r.bucket, (byBucket.get(r.bucket) ?? 0) + r.success + r.fail);
                }
                return byBucket;
              });
              distInflight = { minBucket, p };
              // 成功/失败都清空在飞槽：失败留给下次重试，不让坏 promise 固化。
              p.finally(() => {
                if (distInflight && distInflight.p === p) distInflight = null;
              }).catch(() => {});
              return p;
            })();
      const byBucket = await inflight;
      // 缓存写回只在仍是当前请求（并发两次都写同一结果，幂等）。
      distSeriesCache = {
        minBucket,
        at: now,
        base: [...byBucket.entries()]
          .map(([bucket, calls]) => ({ bucket, calls }))
          .sort((a, b) => (a.bucket < b.bucket ? -1 : b.bucket < a.bucket ? 1 : 0)),
      };
    }
    const result: DistSeriesPoint[] = distSeriesCache.base.map((p) => ({ ...p }));
    const idx = new Map(result.map((p, i) => [p.bucket, i]));
    // pending 叠加：仅 dist 且 bucket >= minBucket，无视 provider 值（pending 桶可能不在 D1 base 里，兜底 0）。
    core.visitPending({ kind: "dist", minBucket }, (e) => {
      let entry = result[idx.get(e.bucket) ?? -1];
      if (!entry) {
        entry = { bucket: e.bucket, calls: 0 };
        idx.set(e.bucket, result.length);
        result.push(entry);
      }
      entry.calls += e.success + e.fail;
    });
    result.sort((a, b) => (a.bucket < b.bucket ? -1 : b.bucket < a.bucket ? 1 : 0));
    return fillRange(result, minBucket, (bucket) => ({ bucket, calls: 0 }));
  }

  /**
   * Dashboard 三张卡（最近 24h / 今日 / 昨日）的 dist 汇总，服务质量端口径。
   * 复读同一份 `dist()` 序列与缓存（不新增 D1 查询）；[fromMs, toMs) 半开区间按桶起算时刻归属。
   * 今日/昨日按 UTC 日边界划分（与"当日"服务端口径一致），上界 `now + BUCKET_MS` 用于把
   * 当前未结束的桶计入。
   */
  async function readDistSummaries(seriesMinBucket: string): Promise<DistSummaries> {
    const points = await dist(seriesMinBucket);
    const now = Date.now();
    const dayStart = Date.parse(utcTodayStart(now) + "Z");
    return {
      last24h: sumDistInRange(points, now - 86_400_000, now + BUCKET_MS),
      today: sumDistInRange(points, dayStart, now + BUCKET_MS),
      yesterday: sumDistInRange(points, dayStart - 86_400_000, dayStart),
    };
  }

  return { upstream, dist, readDistSummaries };
}

/**
 * 从 dist 序列中按 UTC 时间区间求和；[fromMs, toMs) 半开区间，按桶起算时刻归属。
 * `NaN` 桶键跳过（Date.parse 失败不抛）。
 */
export function sumDistInRange(points: DistSeriesPoint[], fromMs: number, toMs: number): number {
  let sum = 0;
  for (const p of points) {
    const t = Date.parse(p.bucket + "Z");
    if (Number.isNaN(t)) continue;
    if (t >= fromMs && t < toMs) sum += p.calls;
  }
  return sum;
}
