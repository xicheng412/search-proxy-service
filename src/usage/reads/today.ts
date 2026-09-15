// 基础设施层·日用量统计的"管理页当日"读产品（原 usage-store.ts 的读侧拆出）。
// 各自持有私有 30s 缓存（读缓存覆盖 minHour 与 scope 集合），D1 现值 + core pending 叠加。
// 依赖方向只向下：reads/ → core → storage/usage → domain；不 import proxy.ts / admin/*。

import type { Env } from "../../types";
import type { DistStats } from "../../domain";
import {
  type UsageIncrement,
  type UsageKind,
  readHourly as storeReadHourly,
  sumUsageByScopes,
} from "../../storage/usage";
import type { UsageCore } from "../core";

export interface TodayOpts {
  /** 当日读缓存 TTL；默认 30s。 */
  readCacheMs?: number;
}

export function makeTodayRead(env: Env, core: UsageCore, opts: TodayOpts = {}) {
  const readCacheMs = opts.readCacheMs ?? 30_000;

  // ---- 读缓存（本 read 产品独立；minHour 与 scope 集合都变才失效）----
  let upstreamCache: {
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

  /** 批量读上游 key 某 UTC 日（minHour 起）统计（展示用，admin 列表页）：D1 现值 + 本实例增量叠加。 */
  async function upstreamToday(
    ids: string[],
    minHour: string
  ): Promise<Record<string, { success: number; fail: number }>> {
    const idsKey = [...ids].sort().join(",");
    const now = Date.now();
    if (
      !upstreamCache ||
      upstreamCache.ids !== idsKey ||
      upstreamCache.minHour !== minHour ||
      now - upstreamCache.at >= readCacheMs
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
      upstreamCache = { ids: idsKey, minHour, at: now, base };
    }
    const result: Record<string, { success: number; fail: number }> = {};
    for (const id of ids) {
      const b = upstreamCache.base[id] ?? { success: 0, fail: 0 };
      // 近似口径：pending 中该 scope 的全部小时增量并入（scope 不含 \u0000，与
      // 原 `k.startsWith("upstream\u0000" + id + "\u0000")` 等价）。
      const approx = { success: 0, fail: 0 };
      core.visitPending({ kind: "upstream", scope: id }, (e) => {
        approx.success += e.success;
        approx.fail += e.fail;
      });
      result[id] = { success: b.success + approx.success, fail: b.fail + approx.fail };
    }
    return result;
  }

  /** 批量读多个分发 key 某 UTC 日统计（展示用）：D1 现值 + 本实例增量叠加。 */
  async function distToday(
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
      core.visitPending({ kind: "dist", scope: key }, (e) => {
        approx.success += e.success;
        approx.fail += e.fail;
      });
      result[key] = { success: b.success + approx.success, fail: b.fail + approx.fail };
    }
    return result;
  }

  /** 读某 scope 的小时明细（给前端组合"今日/最近N小时"边界用）：纯转发 storage 层。 */
  async function hourly(
    kind: UsageKind,
    scope: string,
    minHour: string
  ): Promise<UsageIncrement[]> {
    return storeReadHourly(env, kind, scope, minHour);
  }

  return { upstreamToday, distToday, hourly };
}
