// 纯领域层：类型、领域规则、值语义。零依赖（不 import 本仓库任何模块）。
// 与存储/呈现/传输解耦：storage.ts（持久化）、usage-store.ts（统计缓冲）、
// circuit-breaker.ts（熔断）、proxy.ts（编排）、views（呈现）都只消费这里的词汇。

export type Provider = "tavily" | "exa";
export type KeyStatus = "enabled" | "disabled";

/** 上游 key 仓库描述符（providers/*.ts 提供），供 storage 泛型 CRUD 定位 KV 数组键与 id 前缀。 */
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

export interface DistAuth {
  provider: Provider;
  apiKey: string;
}

/**
 * 领域规则（核心）：解析调用凭据 Bearer `<provider>-<key>`。
 * 前缀（tavily|exa，大小写不敏感）决定路由 provider，`-` 之后的部分是查库的 api_key。
 * 生成的分发 key 是纯字符串（hex，不含 `-`），按第一个 `-` 切分无歧义；
 * 前缀非法或缺失时返回 null。
 */
export function parseDistKey(token: string): DistAuth | null {
  const dash = token.indexOf("-");
  if (dash <= 0) return null; // 无 `-` 或前缀为空
  const prefix = token.slice(0, dash).toLowerCase();
  const apiKey = token.slice(dash + 1);
  if (!apiKey) return null;
  if (prefix !== "tavily" && prefix !== "exa") return null;
  return { provider: prefix, apiKey };
}

// ---------------------------------------------------------------
// 值语义 / 生成（幂等纯函数）
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

// ---------------------------------------------------------------
// 熔断策略常量（领域策略）
// ---------------------------------------------------------------

export const COOLDOWN_THRESHOLD = 5; // 连续失败达到该次数触发冷却
export const COOLDOWN_MS = 60 * 1000; // 冷却时长 60 秒
