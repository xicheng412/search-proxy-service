// 基础设施层·日用量统计的"dashboard 序列"读产品（原 usage-store.ts 的读侧拆出）。
// 全部分发 key 的上游真实调用尝试 / dist 小时序列：D1 base + core pending 叠加；TTL seriesTtlMs。
// 依赖方向只向下：reads/ → core → storage/usage → domain；不 import proxy.ts / admin/*。

import type { Env } from "../../types";
import type { UsageCore } from "../core";
import { readSeriesByProvider as storeReadSeriesByProvider } from "../../storage/usage";
import { hourKey } from "../../domain";

/**
 * dashboard 近5天趋势图单个数据点：某 UTC 小时桶 × provider 的上游真实调用尝试次数（success+fail）。
 * 刻意固化为 tavily/exa 两个字段（计划审批"两条线"展示，见 docs/architecture.md §4.2 已知例外）。
 * 新增 provider 时须同步扩展：本类型、upstream() 内两处 provider 折叠、views/dashboard.ts dashboardScript。
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

export interface SeriesOpts {
  /** 跨 scope 小时序列缓存 TTL；默认 30min（每 isolate 每小时 ≤2 次历史读）。 */
  seriesTtlMs?: number;
}

export function makeSeriesRead(env: Env, core: UsageCore, opts: SeriesOpts = {}) {
  const seriesTtlMs = opts.seriesTtlMs ?? 1_800_000;

  // 跨 scope 小时序列 base（D1 聚合结果），读时叠加 pending；TTL seriesTtlMs。
  // upstream 与 dist 各自独立缓存（同 TTL，读时按需填充）。
  let upstreamSeriesCache: { minHour: string; at: number; base: UpstreamSeriesPoint[] } | null = null;
  let distSeriesCache: { minHour: string; at: number; base: DistSeriesPoint[] } | null = null;

  // Dashboard 序列契约（2026-09 修复）：返回 minHour..当前小时 完整小时序列，无调用桶补 0。
  // 背景：趋势图用 Chart.js time scale 按真实时间间距渲染 x 轴；此前序列只含「有调用的小时」，
  // 缺失小时无槽位 → 无数据小时被跳过、坐标不等间隔（问题记录见 docs/architecture.md §5.2.2）。
  // 异常范围（minHour 晚于当前小时 / 解析失败）兜底：原样返回稀疏数组，绝不抛出。
  function fillRange<T extends { hour: string }>(
    sparse: T[],
    minHour: string,
    zero: (hour: string) => T,
  ): T[] {
    const start = Date.parse(minHour + "Z");
    const end = Date.parse(hourKey() + "Z");
    if (!isFinite(start) || !isFinite(end) || end < start) return sparse;
    const byHour = new Map(sparse.map((p) => [p.hour, p]));
    const out: T[] = [];
    for (let ms = start; ms <= end; ms += 3_600_000) {
      const h = hourKey(ms);
      out.push(byHour.get(h) ?? zero(h));
    }
    return out;
  }

  /**
   * 全部分发 key 的上游真实调用尝试序列（D1 base + pending 叠加；TTL seriesTtlMs）。
   * 下方两处 `if (provider === ...)` 折叠（D1 base 与 pending）按 provider 名硬编码 tavily/exa，
   * 属 docs/architecture.md §4.2 的已知例外：新增 provider 时须扩展 UpstreamSeriesPoint、
   * 本函数两处折叠与 views/dashboard.ts dashboardScript（dist 序列无须参与）。
   * 返回 `minHour..当前小时` 完整小时序列，空桶补 0（原因见 `fillRange` 注释）。
   */
  async function upstream(minHour: string): Promise<UpstreamSeriesPoint[]> {
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
    core.visitPending({ kind: "upstream", minHour }, (e) => {
      let entry = result[idx.get(e.hour) ?? -1];
      if (!entry) {
        entry = { hour: e.hour, tavily: 0, exa: 0 };
        idx.set(e.hour, result.length);
        result.push(entry);
      }
      const calls = e.success + e.fail;
      if (e.provider === "tavily") entry.tavily += calls;
      else if (e.provider === "exa") entry.exa += calls;
    });
    result.sort((a, b) => (a.hour < b.hour ? -1 : b.hour < a.hour ? 1 : 0));
    return fillRange(result, minHour, (hour) => ({ hour, tavily: 0, exa: 0 }));
  }

  /**
   * 全部分发 key 的 dist 小时序列（D1 base + pending 叠加；TTL seriesTtlMs）。
   * calls = 该小时桶跨全部 provider 的 success+fail 合计（不落入 provider 维度）。
   * 返回 `minHour..当前小时` 完整小时序列，空桶补 0（原因见 `fillRange` 注释）。
   */
  async function dist(minHour: string): Promise<DistSeriesPoint[]> {
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
    core.visitPending({ kind: "dist", minHour }, (e) => {
      let entry = result[idx.get(e.hour) ?? -1];
      if (!entry) {
        entry = { hour: e.hour, calls: 0 };
        idx.set(e.hour, result.length);
        result.push(entry);
      }
      entry.calls += e.success + e.fail;
    });
    result.sort((a, b) => (a.hour < b.hour ? -1 : b.hour < a.hour ? 1 : 0));
    return fillRange(result, minHour, (hour) => ({ hour, calls: 0 }));
  }

  return { upstream, dist };
}
