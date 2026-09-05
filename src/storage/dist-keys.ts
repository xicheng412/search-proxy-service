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
  return (res.meta.changes ?? 0) > 0;
}
