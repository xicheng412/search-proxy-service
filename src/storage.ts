// 基础设施层·存储适配器：Cloudflare KV 的纯读写原语 + Keys 数组 CRUD。
// 只负责"键格式、JSON 序列化、单次 KV 操作"——不含任何缓冲/节流/熔断策略。
// 统计的策略在 usage-store.ts（缓冲计数器），熔断策略在 circuit-breaker.ts（续流）。
// 本层不吞错；"写失败是否静默、何时写"由上层策略决定。

import {
  CoreKey,
  DistributedKey,
  UpstreamDef,
  newDistApiKey,
  newUpstreamId,
} from "./domain";

const DIST_KEYS_KEY = "distributed_keys";

// ---------------------------------------------------------------
// 键格式（暴露给上层策略/呈现复用，保证全库同一套命名）
// ---------------------------------------------------------------

export function statsKey(id: string, date: string): string {
  return `stats:${id}:${date}`;
}

export function distStatsKey(apiKey: string, date: string): string {
  return `dist_stats:${apiKey}:${date}`;
}

export function breakerKey(id: string): string {
  return `breaker:${id}`;
}

// ---------------------------------------------------------------
// 数值值读写原语（统计/熔断共用；值为 JSON 对象，字段均为有限数字）
// ---------------------------------------------------------------

/** 读取某计数 key 的当前值：容错解析，仅保留有限数值字段，不可解析视为空。 */
export async function readValueStats(
  kv: KVNamespace,
  key: string
): Promise<Record<string, number>> {
  const raw = await kv.get(key, "text");
  if (!raw) return {};
  try {
    const p = JSON.parse(raw) as Record<string, unknown>;
    const out: Record<string, number> = {};
    for (const [k, v] of Object.entries(p)) {
      if (typeof v === "number" && Number.isFinite(v)) out[k] = v;
    }
    return out;
  } catch {
    return {};
  }
}

/** 用可选 TTL 覆盖写某个计数 key 的完整值（JSON）。不吞错，由上层策略决定容错。 */
export async function writeValueStats(
  kv: KVNamespace,
  key: string,
  value: Record<string, number>,
  ttlSeconds?: number
): Promise<void> {
  const body = JSON.stringify(value);
  if (ttlSeconds) {
    await kv.put(key, body, { expirationTtl: ttlSeconds });
  } else {
    await kv.put(key, body);
  }
}

// ---------------------------------------------------------------
// Keys 数组 CRUD（上游/分发，泛型朝向 UpstreamDef 定位键与 id 前缀）
// ---------------------------------------------------------------

async function readJsonArray<T>(kv: KVNamespace, key: string): Promise<T[]> {
  const raw = await kv.get(key, "text");
  if (!raw) return [];
  try {
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? (parsed as T[]) : [];
  } catch {
    return [];
  }
}

async function writeJsonArray<T>(
  kv: KVNamespace,
  key: string,
  value: T[]
): Promise<void> {
  await kv.put(key, JSON.stringify(value));
}

export async function listUpstreamKeys(
  kv: KVNamespace,
  def: UpstreamDef
): Promise<CoreKey[]> {
  return readJsonArray<CoreKey>(kv, def.keysKey);
}

export async function addUpstreamKey(
  kv: KVNamespace,
  def: UpstreamDef,
  key: string,
  name: string,
  now: number = Date.now()
): Promise<CoreKey> {
  const keys = await listUpstreamKeys(kv, def);
  const item: CoreKey = {
    id: newUpstreamId(def),
    key,
    name: name || "未命名",
    status: "enabled",
    cooldown_until: null,
    created_at: now,
  };
  keys.push(item);
  await writeJsonArray(kv, def.keysKey, keys);
  return item;
}

export async function updateUpstreamKey(
  kv: KVNamespace,
  def: UpstreamDef,
  id: string,
  patch: Partial<Pick<CoreKey, "name" | "status">>
): Promise<CoreKey | null> {
  const keys = await listUpstreamKeys(kv, def);
  const idx = keys.findIndex((k) => k.id === id);
  if (idx === -1) return null;
  const updated: CoreKey = { ...keys[idx], ...patch };
  keys[idx] = updated;
  await writeJsonArray(kv, def.keysKey, keys);
  return updated;
}

/** 设置熔断冷却结束时间戳（null 表示解除冷却）。 */
export async function setUpstreamCooldown(
  kv: KVNamespace,
  def: UpstreamDef,
  id: string,
  cooldown_until: number | null
): Promise<CoreKey | null> {
  const keys = await listUpstreamKeys(kv, def);
  const idx = keys.findIndex((k) => k.id === id);
  if (idx === -1) return null;
  keys[idx] = { ...keys[idx], cooldown_until };
  await writeJsonArray(kv, def.keysKey, keys);
  return keys[idx];
}

export async function deleteUpstreamKey(
  kv: KVNamespace,
  def: UpstreamDef,
  id: string
): Promise<boolean> {
  const keys = await listUpstreamKeys(kv, def);
  const next = keys.filter((k) => k.id !== id);
  if (next.length === keys.length) return false;
  await writeJsonArray(kv, def.keysKey, next);
  return true;
}

export async function listDistributedKeys(
  kv: KVNamespace
): Promise<DistributedKey[]> {
  return readJsonArray<DistributedKey>(kv, DIST_KEYS_KEY);
}

export async function getDistributedKey(
  kv: KVNamespace,
  apiKey: string
): Promise<DistributedKey | null> {
  const keys = await listDistributedKeys(kv);
  return keys.find((k) => k.api_key === apiKey) ?? null;
}

export async function generateDistributedKey(
  kv: KVNamespace,
  note: string,
  now: number = Date.now()
): Promise<DistributedKey> {
  const keys = await listDistributedKeys(kv);
  const apiKey = newDistApiKey();
  // 极低概率碰撞，重试一次
  const item: DistributedKey = {
    api_key: keys.some((k) => k.api_key === apiKey) ? newDistApiKey() : apiKey,
    note,
    status: "enabled",
    created_at: now,
  };
  keys.push(item);
  await writeJsonArray(kv, DIST_KEYS_KEY, keys);
  return item;
}

export async function updateDistributedKey(
  kv: KVNamespace,
  apiKey: string,
  patch: Partial<Pick<DistributedKey, "note" | "status">>
): Promise<DistributedKey | null> {
  const keys = await listDistributedKeys(kv);
  const idx = keys.findIndex((k) => k.api_key === apiKey);
  if (idx === -1) return null;
  keys[idx] = { ...keys[idx], ...patch };
  await writeJsonArray(kv, DIST_KEYS_KEY, keys);
  return keys[idx];
}

export async function deleteDistributedKey(
  kv: KVNamespace,
  apiKey: string
): Promise<boolean> {
  const keys = await listDistributedKeys(kv);
  const next = keys.filter((k) => k.api_key !== apiKey);
  if (next.length === keys.length) return false;
  await writeJsonArray(kv, DIST_KEYS_KEY, next);
  return true;
}
