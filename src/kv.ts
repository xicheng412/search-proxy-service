// KV 数据访问层
// 所有数据存 Cloudflare KV，用带前缀的 key 区分。统计为"尽力而为的近似值"：
// 读-改-写存在竞态，允许少量误差，写失败静默忽略，不阻塞主流程。

export type TavilyStatus = "enabled" | "disabled";

export interface TavilyKey {
  id: string;
  key: string; // Tavily 真实 key，tvly- 开头
  name: string; // 备注
  status: TavilyStatus;
  cooldown_until: number | null; // 熔断冷却截止时间戳(ms)，默认 null
  created_at: number;
}

export interface DistributedKey {
  api_key: string; // 高熵访问密钥，tvly- + 随机串（前缀贴近 Tavily 官方 key）
  note: string; // 备注（必填，区分给谁）
  status: TavilyStatus;
  created_at: number;
  plain_viewed: boolean; // 明文是否已被查看过
}

export interface TavilyStats {
  success: number;
  fail: number;
}

export interface DistStats {
  calls: number;
}

const TAVILY_KEYS_KEY = "tavily_keys";
const DIST_KEYS_KEY = "distributed_keys";

function statsTavilyKey(id: string, date: string): string {
  return `stats:${id}:${date}`;
}

function distStatsKey(id: string, date: string): string {
  return `dist_stats:${id}:${date}`;
}

/**
 * 按 Asia/Shanghai 时区计算"今天"的日期字符串 YYYY-MM-DD。
 * 用 Intl 的 en-CA 格式可直接得到 YYYY-MM-DD。
 */
export function todayDate(t: number = Date.now()): string {
  return new Intl.DateTimeFormat("en-CA", {
    timeZone: "Asia/Shanghai",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(new Date(t));
}

async function readJsonArray<T>(
  kv: KVNamespace,
  key: string
): Promise<T[]> {
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
// 工具函数
// ---------------------------------------------------------------

/** 生成高熵随机 ID 或密钥。len 为字节数，越长熵越高。 */
export function randomToken(len = 24): string {
  const buf = new Uint8Array(len);
  crypto.getRandomValues(buf);
  let s = "";
  for (let i = 0; i < buf.length; i++) {
    s += buf[i].toString(16).padStart(2, "0");
  }
  return s;
}

export function newTavilyId(): string {
  return "tk_" + randomToken(12);
}

export function newDistApiKey(): string {
  // 前缀与长度贴近 Tavily 官方 key（tvly-...），提高第三方工具对该 provider
  // 的兼容性（不少工具会按 tavily key 格式校验前缀/长度）。
  return "tvly-" + randomToken(24);
}

/** 脱敏：只保留前 7 位 + ****，如 tvly-**** */
export function maskKey(key: string): string {
  if (key.length <= 7) return "****";
  return key.slice(0, 7) + "****";
}

// ---------------------------------------------------------------
// Tavily Keys CRUD
// ---------------------------------------------------------------

export async function listTavilyKeys(kv: KVNamespace): Promise<TavilyKey[]> {
  return readJsonArray<TavilyKey>(kv, TAVILY_KEYS_KEY);
}

export async function getTavilyKey(
  kv: KVNamespace,
  id: string
): Promise<TavilyKey | null> {
  const keys = await listTavilyKeys(kv);
  return keys.find((k) => k.id === id) ?? null;
}

export async function addTavilyKey(
  kv: KVNamespace,
  key: string,
  name: string,
  now: number = Date.now()
): Promise<TavilyKey> {
  const keys = await listTavilyKeys(kv);
  const item: TavilyKey = {
    id: newTavilyId(),
    key,
    name: name || "未命名",
    status: "enabled",
    cooldown_until: null,
    created_at: now,
  };
  keys.push(item);
  await writeJsonArray(kv, TAVILY_KEYS_KEY, keys);
  return item;
}

export async function updateTavilyKey(
  kv: KVNamespace,
  id: string,
  patch: Partial<Pick<TavilyKey, "name" | "status">>
): Promise<TavilyKey | null> {
  const keys = await listTavilyKeys(kv);
  const idx = keys.findIndex((k) => k.id === id);
  if (idx === -1) return null;
  const updated: TavilyKey = { ...keys[idx], ...patch };
  keys[idx] = updated;
  await writeJsonArray(kv, TAVILY_KEYS_KEY, keys);
  return updated;
}

/** 设置熔断冷却结束时间戳（null 表示解除冷却） */
export async function setTavilyCooldown(
  kv: KVNamespace,
  id: string,
  cooldown_until: number | null
): Promise<TavilyKey | null> {
  const keys = await listTavilyKeys(kv);
  const idx = keys.findIndex((k) => k.id === id);
  if (idx === -1) return null;
  keys[idx] = { ...keys[idx], cooldown_until };
  await writeJsonArray(kv, TAVILY_KEYS_KEY, keys);
  return keys[idx];
}

export async function deleteTavilyKey(
  kv: KVNamespace,
  id: string
): Promise<boolean> {
  const keys = await listTavilyKeys(kv);
  const next = keys.filter((k) => k.id !== id);
  if (next.length === keys.length) return false;
  await writeJsonArray(kv, TAVILY_KEYS_KEY, next);
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
    plain_viewed: false, // 尚未查看明文
  };
  keys.push(item);
  await writeJsonArray(kv, DIST_KEYS_KEY, keys);
  return item;
}

export async function updateDistributedKey(
  kv: KVNamespace,
  apiKey: string,
  patch: Partial<Pick<DistributedKey, "note" | "status" | "plain_viewed">>
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
// 每日统计（近似值，单一 KV PUT，跨天自然重置）
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

/** Tavily key 当日统计：读取-增量-单次 PUT（尽力而为，写失败静默） */
export async function incrementTavilyStats(
  kv: KVNamespace,
  tavilyId: string,
  delta: { success?: number; fail?: number },
  date: string = todayDate()
): Promise<void> {
  const key = statsTavilyKey(tavilyId, date);
  const cur = await getStats(kv, key);
  cur.success += delta.success ?? 0;
  cur.fail += delta.fail ?? 0;
  try {
    await kv.put(key, JSON.stringify(cur));
  } catch {
    // 静默忽略，不阻塞主流程
  }
}

export async function getTavilyStats(
  kv: KVNamespace,
  tavilyId: string,
  date: string = todayDate()
): Promise<{ success: number; fail: number }> {
  return getStats(kv, statsTavilyKey(tavilyId, date));
}

/** 分发 key 当日统计：调用次数 +1（尽力而为，写失败静默） */
export async function incrementDistCalls(
  kv: KVNamespace,
  apiKey: string,
  date: string = todayDate()
): Promise<void> {
  const key = distStatsKey(apiKey, date);
  let calls = 0;
  const raw = await kv.get(key, "text");
  if (raw) {
    try {
      const p = JSON.parse(raw);
      calls = Number.isFinite(p?.calls) ? p.calls : 0;
    } catch {
      calls = 0;
    }
  }
  calls += 1;
  try {
    await kv.put(key, JSON.stringify({ calls }));
  } catch {
    // 静默忽略
  }
}

export async function getDistCalls(
  kv: KVNamespace,
  apiKey: string,
  date: string = todayDate()
): Promise<number> {
  const raw = await kv.get(distStatsKey(apiKey, date), "text");
  if (!raw) return 0;
  try {
    const p = JSON.parse(raw);
    return Number.isFinite(p?.calls) ? p.calls : 0;
  } catch {
    return 0;
  }
}

export const DAY_MS = 24 * 60 * 60 * 1000;

// ---------------------------------------------------------------
// 熔断：连续失败计数（近似值，非精确并发安全）
// ---------------------------------------------------------------

const COOLDOWN_THRESHOLD = 5; // 连续失败达到该次数触发冷却
export const COOLDOWN_MS = 60 * 1000; // 冷却时长 60 秒

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
export async function recordTavilyFailure(
  kv: KVNamespace,
  id: string,
  now: number = Date.now()
): Promise<void> {
  const consecutive = (await readConsecutive(kv, id)) + 1;
  if (consecutive >= COOLDOWN_THRESHOLD) {
    await setTavilyCooldown(kv, id, now + COOLDOWN_MS).catch(() => {});
    await kv.put(breakerKey(id), JSON.stringify({ consecutive: 0 })).catch(() => {});
  } else {
    await kv.put(breakerKey(id), JSON.stringify({ consecutive })).catch(() => {});
  }
}

/** 记录一次成功：重置连续失败计数。 */
export async function recordTavilySuccess(
  kv: KVNamespace,
  id: string
): Promise<void> {
  await kv.put(breakerKey(id), JSON.stringify({ consecutive: 0 })).catch(() => {});
}

export async function getConsecutiveFailures(
  kv: KVNamespace,
  id: string
): Promise<number> {
  return readConsecutive(kv, id);
}
