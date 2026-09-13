// 基础设施层·计量账本持久化（D1 usage_counts）。
// 用量是跨聚合的独立上下文：upstream（上游 key 成本）与 dist（消费方配额）两条线
// 以 kind 判别列隔离；写入为异步/有损/最终一致（见 usage-store 内存缓冲），
// 不在任一 key 聚合的事务边界内，因此独立成模块而非并入 key 域。
// 本层不吞错；"写失败是否静默、何时写"由上层策略决定。
// 所有函数以 env: Env 为句柄。

import type { Env } from "../types";

export type UsageKind = "upstream" | "dist";

/** 一次用量增量（小时桶）。success/fail 二选一递 1；calls := success + fail 派生。 */
export interface UsageIncrement {
  kind: UsageKind;
  scope: string; // upstream key id | dist api_key
  provider: string | null; // upstream: 'tavily' | 'exa' | future；dist 无 provider 维度，恒 null
  hour: string; // 'YYYY-MM-DDTHH:00' UTC
  success: number;
  fail: number;
}

export interface UsageWindow {
  success: number;
  fail: number;
}

/** 某个小时桶 × provider 的聚合行（跨全部 scope）。dist 无 provider 维度，provider 为 null。 */
export interface HourlyRow {
  hour: string;
  provider: string | null;
  success: number;
  fail: number;
}

/** 批量 merge 用量增量（UPSERT 求和）。用 DB.batch 一次性事务提交。 */
export async function mergeUsage(env: Env, rows: UsageIncrement[]): Promise<void> {
  if (rows.length === 0) return;
  // UPSERT 冲突键 = 0004 后新 PK (kind,scope,hour)。旧 target (kind,scope,provider,hour)
  // 在新 PK 下不匹配任何唯一约束（SQLite 语法报错），故迁移 0004 必须先于新代码部署；
  // 窗口期（旧代码 + 新表）旧 flush 写失败属「写失败静默、统计有损」的既有语义。
  const stmts = rows.map((r) =>
    env.DB.prepare(
      `INSERT INTO usage_counts(kind,scope,provider,hour,success,fail)
       VALUES(?1,?2,?3,?4,?5,?6)
       ON CONFLICT(kind,scope,hour) DO UPDATE SET
         success = success + excluded.success,
         fail    = fail + excluded.fail`
    ).bind(r.kind, r.scope, r.provider, r.hour, r.success, r.fail)
  );
  await env.DB.batch(stmts);
}

/** 多 scope 按 provider 分组的求和（一次往返）。返回 scope -> (provider -> window)。 */
export async function sumUsageByScopes(
  env: Env,
  kind: UsageKind,
  scopes: string[],
  minHour: string
): Promise<Record<string, Record<string, UsageWindow>>> {
  if (scopes.length === 0) return {};
  // D1/SQLite caps numbered bind variables at ?100; kind + minHour use two slots.
  const maxScopesPerQuery = 98;
  const out: Record<string, Record<string, UsageWindow>> = {};
  const mergeRows = (results: unknown[]) => {
    for (const r of results as Record<string, unknown>[]) {
      const scope = r.scope as string;
      // dist 行 provider 为 NULL：归一为空串组键，避免 JS 把 null 转成 "null" 组名。
      (out[scope] ??= {})[(r.provider as string | null) ?? ""] = {
        success: (r.success as number) ?? 0,
        fail: (r.fail as number) ?? 0,
      };
    }
  };

  if (scopes.length <= maxScopesPerQuery) {
    // 单批：保持原有 .all() 路径（fake D1 无 batch 的测试契约）。
    const placeholders = scopes.map((_, i) => `?${i + 2}`).join(",");
    const { results } = await env.DB.prepare(
      `SELECT scope, provider, COALESCE(SUM(success),0) AS success, COALESCE(SUM(fail),0) AS fail
       FROM usage_counts
       WHERE kind = ?1 AND scope IN (${placeholders}) AND hour >= ?${scopes.length + 2}
       GROUP BY scope, provider`
    ).bind(kind, ...scopes, minHour).all();
    mergeRows(results);
    return out;
  }

  // 多批（>98）：构造全部 stmt 后用 DB.batch 一次往返，替代逐批串行 await。
  const stmts: Parameters<typeof env.DB.batch>[0] = [];
  for (let offset = 0; offset < scopes.length; offset += maxScopesPerQuery) {
    const scopeBatch = scopes.slice(offset, offset + maxScopesPerQuery);
    const placeholders = scopeBatch.map((_, i) => `?${i + 2}`).join(",");
    stmts.push(
      env.DB.prepare(
        `SELECT scope, provider, COALESCE(SUM(success),0) AS success, COALESCE(SUM(fail),0) AS fail
         FROM usage_counts
         WHERE kind = ?1 AND scope IN (${placeholders}) AND hour >= ?${scopeBatch.length + 2}
         GROUP BY scope, provider`
      ).bind(kind, ...scopeBatch, minHour)
    );
  }
  const batchResults = await env.DB.batch(stmts);
  for (const r of batchResults) mergeRows(r.results);
  return out;
}

/** 读某 scope 的小时明细（最近 N 小时 / 24 分段给前端组合统计边界用）。 */
export async function readHourly(
  env: Env,
  kind: UsageKind,
  scope: string,
  minHour: string
): Promise<UsageIncrement[]> {
  const { results } = await env.DB.prepare(
    `SELECT kind, scope, provider, hour, success, fail
     FROM usage_counts WHERE kind = ?1 AND scope = ?2 AND hour >= ?3 ORDER BY hour`
  )
    .bind(kind, scope, minHour)
    .all();
  return (results as Record<string, unknown>[]).map((r) => ({
    kind,
    scope,
    provider: r.provider as string | null,
    hour: r.hour as string,
    success: (r.success as number) ?? 0,
    fail: (r.fail as number) ?? 0,
  }));
}

/** 跨全部 scope 按小时桶 × provider 聚合（dashboard 折线序列用）。复用 idx_usage_window 索引。 */
export async function readSeriesByProvider(
  env: Env,
  kind: UsageKind,
  minHour: string
): Promise<HourlyRow[]> {
  const { results } = await env.DB.prepare(
    `SELECT hour, provider, COALESCE(SUM(success),0) AS success, COALESCE(SUM(fail),0) AS fail
     FROM usage_counts
     WHERE kind = ?1 AND hour >= ?2
     GROUP BY hour, provider
     ORDER BY hour`
  )
    .bind(kind, minHour)
    .all();
  return (results as Record<string, unknown>[]).map((r) => ({
    hour: r.hour as string,
    provider: r.provider as string | null,
    success: (r.success as number) ?? 0,
    fail: (r.fail as number) ?? 0,
  }));
}
