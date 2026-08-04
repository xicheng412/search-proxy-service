// KV 数据访问层（泛型：上游 key 由 provider 描述符驱动，代码里无 provider 分支）
// 所有数据存 Cloudflare KV，用带前缀的 key 区分。统计为"尽力而为的近似值"：
// 读-改-写存在竞态，允许少量误差，写失败静默忽略，不阻塞主流程。

export type Provider = "tavily" | "exa";
export type KeyStatus = "enabled" | "disabled";

/** 上游 key 仓库描述符（providers/*.ts 提供），泛型 CRUD 据此定位 KV 数组键与 id 前缀。 */
export interface UpstreamDef {
  keysKey: string;
  idPrefix: string;
}

export interface CoreKey {
  id: string;
  key: string;                     // 上游真实 key（tavily: tvly-*；exa: 无固定前缀）
  name: string;                    // 备注
  status: KeyStatus;
  cooldown_until: number | null;   // 熔断冷却截止时间戳(ms)，默认 null
  created_at: number;
}
export type TavilyKey = CoreKey;
export type ExaKey = CoreKey;

export interface DistributedKey {
  api_key: string;      // 高熵随机字符串（hex），不含任何品牌前缀
  note: string;         // 备注（必填，区分给谁）
  status: KeyStatus;
  created_at: number;
}

export interface TavilyStats {
  success: number;
  fail: number;
}

/** 分发 key 当日调用数：按 provider 拆分（calls = tavily + exa） */
export interface DistStats {
  tavily: number;
  exa: number;
}

const DIST_KEYS_KEY = "distributed_keys";

function statsUpstreamKey(id: string, date: string): string {
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

export function newUpstreamId(def: UpstreamDef): string {
  return def.idPrefix + randomToken(12);
}

/** 分发 key：纯随机字符串（hex，不含 `-`）。请求时用 `Bearer <provider>-<key>` 携带，前缀决定路由。 */
export function newDistApiKey(): string {
  return randomToken(24);
}

/** 脱敏：只保留前 7 位 + ****，如 tvly-**** */
export function maskKey(key: string): string {
  if (key.length <= 7) return "****";
  return key.slice(0, 7) + "****";
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

export async function getConsecutiveFailures(
  kv: KVNamespace,
  id: string
): Promise<number> {
  return readConsecutive(kv, id);
}
