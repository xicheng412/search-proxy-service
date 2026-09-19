// 基础设施层·日用量统计的"权重信号"读产品（原 usage-store.ts 的读侧拆出）。
// 热路径选 key 信号：滑动窗口失败数快照（后台刷新，最长陈旧 signalBaseTtlMs）+ core pending 叠加，
// 每请求 0 次 D1 往返。signalBase 状态归本模块闭包；刷新驱动共三处：flush 落库钩子（组合根 index.ts onFlushed）、
// QueueDO drain 每任务前置 refreshWeightBase（queue/durable-object.ts）、外部显式调用 refreshWeightBase；
// 三处共用 maybeRefresh 的 TTL+minHour 自节流。
// 依赖方向只向下：reads/ → core → storage/usage → domain；不 import proxy.ts / admin/*。

import type { Env } from "../../types";
import { hourKey } from "../../domain";
import type { UsageCore } from "../core";

export interface WeightOpts {
  /** 权重信号滑动窗口（ms）；只影响热路径选 key 的信号，不影响展示口径。默认 30min。 */
  weightWindowMs?: number;
  /** 后台统计信号快照最大陈旧时长；默认 120s，测试可缩短窗口。 */
  signalBaseTtlMs?: number;
}

export function makeWeightSignal(env: Env, core: UsageCore, opts: WeightOpts = {}) {
  const weightWindowMs = opts.weightWindowMs ?? 30 * 60 * 1000;
  const signalBaseTtlMs = opts.signalBaseTtlMs ?? 120_000;

  // 热路径选 key 信号：滑动窗口失败数快照，由 flush/drain/显式三驱动后台刷新，最长陈旧 signalBaseTtlMs。
  let signalBase: { minHour: string; at: number; fail: Record<string, number> } | null = null;

  /**
   * 惰性刷新信号快照：空 base / 窗口下界变化 / 超 TTL 才查询；失败由调用方吞掉，保留旧 base。
   * 不吞错——吞错由组合根调用点负责（onFlushed 钩子与 refreshWeightBase 各自 catch）。
   */
  async function maybeRefresh(): Promise<void> {
    const minHour = hourKey(Date.now() - weightWindowMs);
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

  /** 热路径选 key 信号：滑动窗口失败数快照（后台刷新）+ 本实例 pending；0 次 D1 往返。 */
  async function readSignal(ids: string[]): Promise<Record<string, number>> {
    if (ids.length === 0) return {};
    const minHour = hourKey(Date.now() - weightWindowMs);
    const out: Record<string, number> = {};
    for (const id of ids) {
      let f = signalBase && signalBase.minHour === minHour ? (signalBase.fail[id] ?? 0) : 0;
      core.visitPending(
        { kind: "upstream", scope: id, minHour },
        (e) => {
          // 只累加落在滑动窗口内的小时桶；flush 拉长后 pending 可能横跨多个小时桶，
          // 越窗失败不计入权重（口径与 signalBase 的 D1 窗口 SUM 一致）。
          f += e.fail;
        }
      );
      out[id] = f;
    }
    return out;
  }

  /** 立即刷新权重信号 base（空 base / 窗口下界变化 / 超 TTL 才查 D1，否则 0 IO no-op）。
   *  沿用 maybeRefresh 的 TTL + minHour 双条件自节流；不吞错——吞错由组合根调用点负责。 */
  async function refreshNow(): Promise<void> {
    await maybeRefresh();
  }

  return { readSignal, refreshNow };
}
