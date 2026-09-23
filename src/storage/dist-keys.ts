// 基础设施层·DistributedKey 聚合持久化（D1 distributed_keys + Cache API 读缓存）。
// 对外分发的消费 key：status 门控热路径校验；Cache API 是该聚合仓储的内部读优化
// （getDistributedKey 读穿 + 写操作失效），TTL 由 dist_cache_config（KV，运行时可调）控制，
// 撤销/禁用的最坏生效延迟 = cacheTtlSec。缓存写/失效失败静默，不影响主流程。
// 本层其余不吞错；"写失败是否静默、何时写"由上层策略决定。
// 所有函数以 env: Env 为句柄（同时携带 KV 与 DB）。

import type { Env } from "../types";
import {
  DistributedKey,
  KeyStatus,
  newDistApiKey,
} from "../domain";
import { cachedDistCacheConfig } from "../dist-cache-config";
import { buildSetClause } from "./patch";

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

function toDistKey(r: Record<string, unknown>): DistributedKey {
  return {
    api_key: r.api_key as string,
    note: r.note as string,
    status: r.status as KeyStatus,
    created_at: r.created_at as number,
  };
}

/** 分发 Keys 管理页 keyset 分页游标：稳定排序/边界键 (created_at, api_key) 的镜像（created_at 相同由 api_key 决胜）。 */
export interface DistributedKeyCursor {
  createdAt: number;
  apiKey: string;
}

/** 管理页单页结果：keys 为当前页（≤ limit），方向标记与游标给出可跳转的相邻页。 */
export interface DistributedKeyPage {
  keys: DistributedKey[];
  hasPrevious: boolean;
  hasNext: boolean;
  previousCursor: DistributedKeyCursor | null;
  nextCursor: DistributedKeyCursor | null;
}

/**
 * 管理页 keyset 分页读取：只服务 /admin/keys GET；固定传入 20。
 * 首页/after/before 三种 SQL 都走 (created_at, api_key) 复合索引；
 * 排序始终为 created_at ASC, api_key ASC（before 页逆序读后在内存反转）。
 * LIMIT 多取一行仅用于 hasNext/hasPrevious 判断，不返回给视图。
 */
export async function listDistributedKeysPage(
  env: Env,
  opts: {
    after: DistributedKeyCursor | null;
    before: DistributedKeyCursor | null;
    limit: number;
  }
): Promise<DistributedKeyPage> {
  const { after, before, limit } = opts;
  if (after !== null && before !== null) {
    throw new Error("listDistributedKeysPage: after 与 before 互斥");
  }
  if (!Number.isInteger(limit) || limit <= 0) {
    throw new Error("listDistributedKeysPage: limit 必须为正整数");
  }
  const fetchLimit = limit + 1;

  // before：逆序取行，内存反转回升序；after/首页：升序取。
  const goingBack = before !== null;
  const sql = goingBack
    ? `SELECT api_key, note, status, created_at
       FROM distributed_keys
       WHERE (created_at, api_key) < (?1, ?2)
       ORDER BY created_at DESC, api_key DESC
       LIMIT ?3`
    : after !== null
      ? `SELECT api_key, note, status, created_at
         FROM distributed_keys
         WHERE (created_at, api_key) > (?1, ?2)
         ORDER BY created_at ASC, api_key ASC
         LIMIT ?3`
      : `SELECT api_key, note, status, created_at
         FROM distributed_keys
         ORDER BY created_at ASC, api_key ASC
         LIMIT ?1`;
  const binds: unknown[] = goingBack
    ? [before.createdAt, before.apiKey, fetchLimit]
    : after !== null
      ? [after.createdAt, after.apiKey, fetchLimit]
      : [fetchLimit];
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
  const cursorOf = (r: Record<string, unknown>): DistributedKeyCursor => ({
    createdAt: r.created_at as number,
    apiKey: r.api_key as string,
  });
  return {
    keys: pageRows.map(toDistKey),
    hasPrevious: hasPreviousPage,
    hasNext: hasNextPage,
    previousCursor: hasPreviousPage ? cursorOf(pageRows[0]) : null,
    nextCursor: hasNextPage ? cursorOf(pageRows[pageRows.length - 1]) : null,
  };
}

/** dashboard 统计卡用：全局计数 total/enabled（dist 无 provider 维度）。 */
export async function countDistributedKeys(
  env: Env
): Promise<{ total: number; enabled: number }> {
  const row = await env.DB.prepare(
    `SELECT COUNT(*) AS total,
            COALESCE(SUM(CASE WHEN status = 'enabled' THEN 1 ELSE 0 END), 0) AS enabled
     FROM distributed_keys`
  ).first();
  return { total: Number(row?.total ?? 0), enabled: Number(row?.enabled ?? 0) };
}

// 惰性总数缓存：总量基本不变，低频读「共 N 条」，变动（generate/delete）时同 isolate 立即失效，
// 跨 isolate 由 TTL 兜底（最多 60s 陈旧，用户接受「大致统计」）。
let distCountCache: { at: number; total: number } | null = null;
const DIST_COUNT_TTL_MS = 60_000;

export function clearDistributedKeyCountCache(): void {
  distCountCache = null;
}

export async function cachedDistributedKeyCount(env: Env): Promise<number> {
  const now = Date.now();
  if (distCountCache && now - distCountCache.at < DIST_COUNT_TTL_MS) return distCountCache.total;
  const r = await countDistributedKeys(env);
  distCountCache = { at: now, total: r.total };
  return r.total;
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
  now: number = Date.now(),
  nonce?: string
): Promise<DistributedKey> {
  // nonce 幂等：同一 nonce 在 TTL 内重复调用 → 返回同一把已存在 key（双击防重）。
  if (nonce) {
    const stored = await env.KV.get("keygen_nonce:" + nonce);
    if (stored) {
      const existing = await getDistributedKey(env, stored);
      if (existing) return existing;
    }
  }
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
  clearDistributedKeyCountCache();
  // 落 nonce → key 映射（TTL 300s）。失败静默：最多失去一次幂等窗口，不阻塞主流程。
  if (nonce) {
    await env.KV.put("keygen_nonce:" + nonce, final, { expirationTtl: 300 }).catch(() => {});
  }
  return item;
}

export async function updateDistributedKey(
  env: Env,
  apiKey: string,
  patch: Partial<Pick<DistributedKey, "note" | "status">>
): Promise<DistributedKey | null> {
  const { sets, binds } = buildSetClause(patch, ["note", "status"], 1);
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
  clearDistributedKeyCountCache();
  return (res.meta.changes ?? 0) > 0;
}
