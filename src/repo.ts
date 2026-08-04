// 基础设施层：Cloudflare KV 的持久化 + 每日统计 + 熔断。
// 只依赖 domain.ts 的类型/值/策略常量，本身不含业务规则。写失败静默忽略，不阻塞主流程。

import {
  COOLDOWN_MS,
  COOLDOWN_THRESHOLD,
  CoreKey,
  DistributedKey,
  DistStats,
  Provider,
  UpstreamDef,
  newDistApiKey,
  newUpstreamId,
  todayDate,
} from "./domain";

const DIST_KEYS_KEY = "distributed_keys";

function statsUpstreamKey(id: string, date: string): string {
  return `stats:${id}:${date}`;
}

function distStatsKey(id: string, date: string): string {
  return `dist_stats:${id}:${date}`;
}

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

// ---------------------------------------------------------------
// 上游 Keys CRUD（泛型，按 UpstreamDef 定位 KV 数组与 id 前缀）
// ---------------------------------------------------------------

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

/** 设置熔断冷却结束时间戳（null 表示解除冷却） */
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

// ---------------------------------------------------------------
// 分发 Keys CRUD
// ---------------------------------------------------------------

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

// ---------------------------------------------------------------
// 每日统计（近似值：读-改-写存在竞态，单一 KV PUT，跨天自然重置）
// ---------------------------------------------------------------

async function getStats(
  kv: KVNamespace,
  key: string
): Promise<{ success: number; fail: number }> {
  const raw = await kv.get(key, "text");
  if (!raw) return { success: 0, fail: 0 };
  try {
    const p = JSON.parse(raw);
    return {
      success: Number.isFinite(p?.success) ? p.success : 0,
      fail: Number.isFinite(p?.fail) ? p.fail : 0,
    };
  } catch {
    return { success: 0, fail: 0 };
  }
}

/** 上游 key 当日统计：读取-增量-单次 PUT（尽力而为，写失败静默）。按 id 区分，天然按 provider 隔离。 */
export async function incrementUpstreamStats(
  kv: KVNamespace,
  id: string,
  delta: { success?: number; fail?: number },
  date: string = todayDate()
): Promise<void> {
  const key = statsUpstreamKey(id, date);
  const cur = await getStats(kv, key);
  cur.success += delta.success ?? 0;
  cur.fail += delta.fail ?? 0;
  try {
    await kv.put(key, JSON.stringify(cur));
  } catch {
    // 静默忽略，不阻塞主流程
  }
}

export async function getUpstreamStats(
  kv: KVNamespace,
  id: string,
  date: string = todayDate()
): Promise<{ success: number; fail: number }> {
  return getStats(kv, statsUpstreamKey(id, date));
}

/** 分发 key 当日统计：对应 provider 调用数 +1（尽力而为，写失败静默） */
export async function incrementDistCalls(
  kv: KVNamespace,
  apiKey: string,
  provider: Provider,
  date: string = todayDate()
): Promise<void> {
  const key = distStatsKey(apiKey, date);
  const cur = await getDistCalls(kv, apiKey, date);
  if (provider === "exa") cur.exa += 1;
  else cur.tavily += 1;
  try {
    await kv.put(key, JSON.stringify(cur));
  } catch {
    // 静默忽略
  }
}

export async function getDistCalls(
  kv: KVNamespace,
  apiKey: string,
  date: string = todayDate()
): Promise<DistStats> {
  const raw = await kv.get(distStatsKey(apiKey, date), "text");
  if (!raw) return { tavily: 0, exa: 0 };
  try {
    const p = JSON.parse(raw);
    return {
      tavily: Number.isFinite(p?.tavily) ? p.tavily : 0,
      exa: Number.isFinite(p?.exa) ? p.exa : 0,
    };
  } catch {
    return { tavily: 0, exa: 0 };
  }
}

// ---------------------------------------------------------------
// 熔断：连续失败计数（近似值，非精确并发安全）
// ---------------------------------------------------------------

function breakerKey(id: string): string {
  return `breaker:${id}`;
}

async function readConsecutive(
  kv: KVNamespace,
  id: string
): Promise<number> {
  const raw = await kv.get(breakerKey(id), "text");
  if (!raw) return 0;
  try {
    const p = JSON.parse(raw);
    return Number.isFinite(p?.consecutive) ? p.consecutive : 0;
  } catch {
    return 0;
  }
}

/**
 * 记录一次失败：连续失败计数 +1；若达到阈值，为该 key 设置冷却
 * （cooldown_until = now + COOLDOWN_MS）并重置连续计数。
 */
export async function recordUpstreamFailure(
  kv: KVNamespace,
  def: UpstreamDef,
  id: string,
  now: number = Date.now()
): Promise<void> {
  const consecutive = (await readConsecutive(kv, id)) + 1;
  if (consecutive >= COOLDOWN_THRESHOLD) {
    await setUpstreamCooldown(kv, def, id, now + COOLDOWN_MS).catch(() => {});
    await kv.put(breakerKey(id), JSON.stringify({ consecutive: 0 })).catch(() => {});
  } else {
    await kv.put(breakerKey(id), JSON.stringify({ consecutive })).catch(() => {});
  }
}

/** 记录一次成功：重置连续失败计数。 */
export async function recordUpstreamSuccess(
  kv: KVNamespace,
  id: string
): Promise<void> {
  await kv.put(breakerKey(id), JSON.stringify({ consecutive: 0 })).catch(() => {});
}
