// 基础设施层·存储适配器（D1/SQLite）。实体数据全部落 D1：
//   - upstream_keys / distributed_keys（key 仓库）
//   - usage_counts（用量小时桶，UTC）
//   - breaker_state（熔断连续失败计数）
// 基础配置（breaker_config/queue_config）与登录会话仍留 KV，不在本层。
// 本层不吞错；"写失败是否静默、何时写"由上层策略决定。
// 所有函数以 env: Env 为句柄（同时携带 KV 与 DB），实体走 DB，配置/会话走 KV。

import type { Env } from "./types";
import {
  CoreKey,
  DistributedKey,
  KeyStatus,
  UpstreamDef,
  newDistApiKey,
  newUpstreamId,
} from "./domain";
import { cachedDistCacheConfig } from "./dist-cache-config";

const distCacheKey = (apiKey: string) =>
  `https://search-proxy.internal/dist-key/${encodeURIComponent(apiKey)}`;

async function cacheGetDist(
  _env: Env,
  apiKey: string
): Promise<DistributedKey | null | undefined> {
  const hit = await caches.default.match(distCacheKey(apiKey));
  if (!hit) return undefined;
  const body = await hit.json<{ found: boolean; key?: DistributedKey }>();
  return body.found ? (body.key as DistributedKey) : null;
}

async function cachePutDist(
  _env: Env,
  apiKey: string,
  value: DistributedKey | null,
  ttlSec: number
): Promise<void> {
  const resp = new Response(
    JSON.stringify({ found: value !== null, key: value ?? undefined }),
    { headers: { "Cache-Control": `max-age=${ttlSec}` } }
  );
  await caches.default.put(distCacheKey(apiKey), resp);
}

const distCacheConfig = cachedDistCacheConfig();

export type UsageKind = "upstream" | "dist";

/** 一次用量增量（小时桶）。success/fail 二选一递 1；calls := success + fail 派生。 */
export interface UsageIncrement {
  kind: UsageKind;
  scope: string; // upstream key id | dist api_key
  provider: string; // 'tavily' | 'exa' | future
  hour: string; // 'YYYY-MM-DDTHH:00' UTC
  success: number;
  fail: number;
}

export interface UsageWindow {
  success: number;
  fail: number;
}

/** 熔断状态行：连续失败 + 更新时间（模拟 KV 的 10min TTL 窗口）。 */
export interface BreakerState {
  consecutive: number;
  updated_at: number;
  created_at: number;
}

function toCoreKey(r: Record<string, unknown>): CoreKey {
  return {
    id: r.id as string,
    key: r.key as string,
    name: r.name as string,
    status: r.status as KeyStatus,
    cooldown_until: r.cooldown_until as number | null,
    created_at: r.created_at as number,
  };
}

function toDistKey(r: Record<string, unknown>): DistributedKey {
  return {
    api_key: r.api_key as string,
    note: r.note as string,
    status: r.status as KeyStatus,
    created_at: r.created_at as number,
  };
}

// ---------------------------------------------------------------
// 上游 keys
// ---------------------------------------------------------------

/** 分页游标：稳定排序/边界键 (created_at, id) 的镜像（created_at 相同由 id 决胜）。 */
export interface UpstreamKeyCursor {
  createdAt: number;
  id: string;
}

/** 管理页单页结果：keys 为当前页（≤ limit），方向标记与游标给出可跳转的相邻页。 */
export interface UpstreamKeyPage {
  keys: CoreKey[];
  hasPrevious: boolean;
  hasNext: boolean;
  previousCursor: UpstreamKeyCursor | null;
  nextCursor: UpstreamKeyCursor | null;
}

export async function listUpstreamKeys(
  env: Env,
  def: UpstreamDef
): Promise<CoreKey[]> {
  const { results } = await env.DB.prepare(
    "SELECT id, key, name, status, cooldown_until, created_at FROM upstream_keys WHERE provider = ?1 ORDER BY created_at"
  ).bind(def.provider).all();
  return (results as Record<string, unknown>[]).map(toCoreKey);
}

/** 按 provider + id 单行读取（管理页 name/toggle 用，避免为一条 key 拉全量列表）。 */
export async function getUpstreamKey(
  env: Env,
  def: UpstreamDef,
  id: string
): Promise<CoreKey | null> {
  const row = await env.DB.prepare(
    "SELECT id, key, name, status, cooldown_until, created_at FROM upstream_keys WHERE provider = ?1 AND id = ?2"
  )
    .bind(def.provider, id)
    .first();
  return row ? toCoreKey(row as Record<string, unknown>) : null;
}

/**
 * 管理页 keyset 分页读取：只服务 Tavily/Exa admin GET；固定传入 20。
 * 首页/after/before 三种 SQL 都走 (provider, created_at, id) 复合索引；
 * 排序始终为 created_at ASC, id ASC（before 页逆序读后在内存反转）。
 * LIMIT 多取一行仅用于 hasNext/hasPrevious 判断，不返回给视图。
 */
export async function listUpstreamKeysPage(
  env: Env,
  def: UpstreamDef,
  opts: {
    after: UpstreamKeyCursor | null;
    before: UpstreamKeyCursor | null;
    limit: number;
  }
): Promise<UpstreamKeyPage> {
  const { after, before, limit } = opts;
  if (after !== null && before !== null) {
    throw new Error("listUpstreamKeysPage: after 与 before 互斥");
  }
  if (!Number.isInteger(limit) || limit <= 0) {
    throw new Error("listUpstreamKeysPage: limit 必须为正整数");
  }
  const fetchLimit = limit + 1;

  // before：逆序取上游行，内存反转回升序；after/首页：升序取。
  const goingBack = before !== null;
  const sql = goingBack
    ? `SELECT id, key, name, status, cooldown_until, created_at
       FROM upstream_keys
       WHERE provider = ?1 AND (created_at, id) < (?2, ?3)
       ORDER BY created_at DESC, id DESC
       LIMIT ?4`
    : after !== null
      ? `SELECT id, key, name, status, cooldown_until, created_at
         FROM upstream_keys
         WHERE provider = ?1 AND (created_at, id) > (?2, ?3)
         ORDER BY created_at ASC, id ASC
         LIMIT ?4`
      : `SELECT id, key, name, status, cooldown_until, created_at
         FROM upstream_keys
         WHERE provider = ?1
         ORDER BY created_at ASC, id ASC
         LIMIT ?2`;
  const binds: unknown[] = goingBack
    ? [def.provider, before.createdAt, before.id, fetchLimit]
    : after !== null
      ? [def.provider, after.createdAt, after.id, fetchLimit]
      : [def.provider, fetchLimit];
  const { results } = await env.DB.prepare(sql).bind(...binds).all();
  const raw = results as Record<string, unknown>[];
  const pageRows = goingBack ? raw.slice(0, limit).reverse() : raw.slice(0, limit);
  const hasNextPage = goingBack ? true : raw.length > limit;
  const hasPreviousPage = goingBack ? raw.length > limit : after !== null;

  if (pageRows.length === 0) {
    // 空表/游标无结果：不抛错，两个方向都标记为 false，视图保留"首页"恢复链接。
    return {
      keys: [],
      hasPrevious: false,
      hasNext: false,
      previousCursor: null,
      nextCursor: null,
    };
  }
  const cursorOf = (r: Record<string, unknown>): UpstreamKeyCursor => ({
    createdAt: r.created_at as number,
    id: r.id as string,
  });
  return {
    keys: pageRows.map(toCoreKey),
    hasPrevious: hasPreviousPage,
    hasNext: hasNextPage,
    previousCursor: hasPreviousPage ? cursorOf(pageRows[0]) : null,
    nextCursor: hasNextPage ? cursorOf(pageRows[pageRows.length - 1]) : null,
  };
}

export async function addUpstreamKey(
  env: Env,
  def: UpstreamDef,
  key: string,
  name: string,
  now: number = Date.now()
): Promise<CoreKey> {
  const item: CoreKey = {
    id: newUpstreamId(def),
    key,
    name: name || "未命名",
    status: "enabled",
    cooldown_until: null,
    created_at: now,
  };
  await env.DB.prepare(
    "INSERT INTO upstream_keys(provider,id,key,name,status,cooldown_until,created_at) VALUES(?1,?2,?3,?4,?5,?6,?7)"
  )
    .bind(def.provider, item.id, item.key, item.name, item.status, null, item.created_at)
    .run();
  return item;
}

export async function updateUpstreamKey(
  env: Env,
  def: UpstreamDef,
  id: string,
  patch: Partial<Pick<CoreKey, "name" | "status">>
): Promise<CoreKey | null> {
  const sets: string[] = [];
  const binds: unknown[] = [];
  if (patch.name !== undefined) {
    sets.push("name = ?" + (binds.length + 1));
    binds.push(patch.name);
  }
  if (patch.status !== undefined) {
    sets.push("status = ?" + (binds.length + 1));
    binds.push(patch.status);
  }
  if (sets.length === 0) return listUpstreamKeys(env, def).then((ks) => ks.find((k) => k.id === id) ?? null);
  const whereIdx = binds.length + 1;
  const sql =
    `UPDATE upstream_keys SET ${sets.join(", ")} WHERE provider = ?${whereIdx} AND id = ?${whereIdx + 1} RETURNING id, key, name, status, cooldown_until, created_at`;
  const row = await env.DB.prepare(sql).bind(...binds, def.provider, id).first();
  return row ? toCoreKey(row as Record<string, unknown>) : null;
}

export async function setUpstreamCooldown(
  env: Env,
  def: UpstreamDef,
  id: string,
  cooldown_until: number | null
): Promise<CoreKey | null> {
  const row = await env.DB.prepare(
    "UPDATE upstream_keys SET cooldown_until = ?1 WHERE provider = ?2 AND id = ?3 RETURNING id, key, name, status, cooldown_until, created_at"
  )
    .bind(cooldown_until, def.provider, id)
    .first();
  return row ? toCoreKey(row as Record<string, unknown>) : null;
}

export async function deleteUpstreamKey(
  env: Env,
  def: UpstreamDef,
  id: string
): Promise<boolean> {
  const res = await env.DB.prepare(
    "DELETE FROM upstream_keys WHERE provider = ?1 AND id = ?2"
  )
    .bind(def.provider, id)
    .run();
  return (res.meta.changes ?? 0) > 0;
}

// ---------------------------------------------------------------
// 分发 keys
// ---------------------------------------------------------------

export async function listDistributedKeys(env: Env): Promise<DistributedKey[]> {
  const { results } = await env.DB.prepare(
    "SELECT api_key, note, status, created_at FROM distributed_keys ORDER BY created_at"
  ).all();
  return (results as Record<string, unknown>[]).map(toDistKey);
}

export async function getDistributedKey(
  env: Env,
  apiKey: string
): Promise<DistributedKey | null> {
  const cached = await cacheGetDist(env, apiKey).catch(() => undefined);
  if (cached !== undefined) return cached;
  const row = await env.DB.prepare(
    "SELECT api_key, note, status, created_at FROM distributed_keys WHERE api_key = ?1"
  )
    .bind(apiKey)
    .first();
  const value = row ? toDistKey(row as Record<string, unknown>) : null;
  const ttl = (await distCacheConfig.get(env.KV)).cacheTtlSec;
  await cachePutDist(env, apiKey, value, ttl).catch(() => {});
  return value;
}

export async function generateDistributedKey(
  env: Env,
  note: string,
  now: number = Date.now()
): Promise<DistributedKey> {
  const apiKey = newDistApiKey();
  // 极低概率碰撞，重试一次
  const final =
    (await getDistributedKey(env, apiKey)) !== null ? newDistApiKey() : apiKey;
  const item: DistributedKey = { api_key: final, note, status: "enabled", created_at: now };
  await env.DB.prepare(
    "INSERT INTO distributed_keys(api_key,note,status,created_at) VALUES(?1,?2,?3,?4)"
  )
    .bind(item.api_key, item.note, item.status, item.created_at)
    .run();
  await caches.default.delete(distCacheKey(final)).catch(() => {});
  return item;
}

export async function updateDistributedKey(
  env: Env,
  apiKey: string,
  patch: Partial<Pick<DistributedKey, "note" | "status">>
): Promise<DistributedKey | null> {
  const sets: string[] = [];
  const binds: unknown[] = [];
  if (patch.note !== undefined) {
    sets.push("note = ?" + (binds.length + 1));
    binds.push(patch.note);
  }
  if (patch.status !== undefined) {
    sets.push("status = ?" + (binds.length + 1));
    binds.push(patch.status);
  }
  if (sets.length === 0) return getDistributedKey(env, apiKey);
  const sql =
    `UPDATE distributed_keys SET ${sets.join(", ")} WHERE api_key = ?${binds.length + 1} RETURNING api_key, note, status, created_at`;
  const row = await env.DB.prepare(sql).bind(...binds, apiKey).first();
  if (row) {
    await caches.default.delete(distCacheKey(apiKey)).catch(() => {});
    return toDistKey(row as Record<string, unknown>);
  }
  return null;
}
export async function deleteDistributedKey(
  env: Env,
  apiKey: string
): Promise<boolean> {
  const res = await env.DB.prepare("DELETE FROM distributed_keys WHERE api_key = ?1")
    .bind(apiKey)
    .run();
  await caches.default.delete(distCacheKey(apiKey)).catch(() => {});
  return (res.meta.changes ?? 0) > 0;
}


// ---------------------------------------------------------------
// 用量小时桶
// ---------------------------------------------------------------

/** 批量 merge 用量增量（UPSERT 求和）。用 DB.batch 一次性事务提交。 */
export async function mergeUsage(env: Env, rows: UsageIncrement[]): Promise<void> {
  if (rows.length === 0) return;
  const stmts = rows.map((r) =>
    env.DB.prepare(
      `INSERT INTO usage_counts(kind,scope,provider,hour,success,fail)
       VALUES(?1,?2,?3,?4,?5,?6)
       ON CONFLICT(kind,scope,provider,hour) DO UPDATE SET
         success = success + excluded.success,
         fail    = fail + excluded.fail`
    ).bind(r.kind, r.scope, r.provider, r.hour, r.success, r.fail)
  );
  await env.DB.batch(stmts);
}

/** 按时间窗求和（hour >= minHour 的 UTC 小时桶）。 */
export async function sumUsage(
  env: Env,
  kind: UsageKind,
  scope: string,
  provider: string,
  minHour: string
): Promise<UsageWindow> {
  const row = await env.DB.prepare(
    `SELECT COALESCE(SUM(success),0) AS success, COALESCE(SUM(fail),0) AS fail
     FROM usage_counts WHERE kind = ?1 AND scope = ?2 AND provider = ?3 AND hour >= ?4`
  )
    .bind(kind, scope, provider, minHour)
    .first();
  return { success: (row?.success as number) ?? 0, fail: (row?.fail as number) ?? 0 };
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
      (out[scope] ??= {})[r.provider as string] = {
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
    provider: r.provider as string,
    hour: r.hour as string,
    success: (r.success as number) ?? 0,
    fail: (r.fail as number) ?? 0,
  }));
}

// ---------------------------------------------------------------
// 熔断状态（breaker_state）
// ---------------------------------------------------------------

export async function readBreakerState(
  env: Env,
  id: string
): Promise<BreakerState | null> {
  const row = await env.DB.prepare(
    "SELECT consecutive, updated_at, created_at FROM breaker_state WHERE id = ?1"
  )
    .bind(id)
    .first();
  return row
    ? {
        consecutive: row.consecutive as number,
        updated_at: row.updated_at as number,
        created_at: row.created_at as number,
      }
    : null;
}

/** 原子批写某次上游结果的 cooldown 更新 + 可选熔断计数 UPSERT。 */
export async function applyBreakerOutcome(
  env: Env,
  def: UpstreamDef,
  id: string,
  cooldownUntil: number,
  consecutive: number | null,
  now: number,
  createdAt: number = now
): Promise<void> {
  const stmts = [
    env.DB.prepare(
      "UPDATE upstream_keys SET cooldown_until = ?1 WHERE provider = ?2 AND id = ?3"
    ).bind(cooldownUntil, def.provider, id),
  ];
  if (consecutive !== null) {
    stmts.push(
      env.DB.prepare(
        `INSERT INTO breaker_state(id,consecutive,updated_at,created_at) VALUES(?1,?2,?3,?4)
         ON CONFLICT(id) DO UPDATE SET consecutive = excluded.consecutive, updated_at = excluded.updated_at`
      ).bind(id, consecutive, now, createdAt)
    );
  }
  await env.DB.batch(stmts);
}
