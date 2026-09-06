// 纯领域层：类型、领域规则、值语义。零依赖（不 import 本仓库任何模块）。
// 与存储/呈现/传输解耦：storage.ts（持久化）、usage-store.ts（统计缓冲）、
// circuit-breaker.ts（熔断）、proxy.ts（编排）、views（呈现）都只消费这里的词汇。

export type Provider = "tavily" | "exa";

/** 调用侧线协议：native = 原样透传上游协议；searxng = SearXNG 兼容协议（需协议转换）。 */
export type WireProtocol = "native" | "searxng";

export type KeyStatus = "enabled" | "disabled";

/** 上游 key 仓库描述符（providers/*.ts 提供），供 storage 泛型 CRUD 定位 provider 维度。 */
export interface UpstreamDef {
  keysKey: string;
  idPrefix: string;
  /** 表 provider 维度（'tavily' | 'exa' | 未来）。 */
  provider: Provider;
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

/** 分发 key 请求计数（calls = success + fail 派生），不区分后端/协议。 */
export interface DistStats {
  success: number;
  fail: number;
}

export interface DistAuth {
  protocol: WireProtocol;
  provider: Provider;
  apiKey: string;
}

/**
 * 领域规则（核心）：解析调用凭据 Bearer `<protocol?/-><provider>-<key>`。
 * 复合前缀（大写不敏感）同时决定「线协议」与「路由 provider」：
 *   tavily-<key>         → protocol=native,  provider=tavily   （原样透传 Tavily）
 *   exa-<key>            → protocol=native,  provider=exa      （原样透传 Exa）
 *   searxng-tavily-<key> → protocol=searxng, provider=tavily   （SearXNG 协议，走 Tavily 后端）
 * 生成的分发 key 是纯字符串（hex，不含 `-`），按最后一个 `-` 切分无歧义；
 * 前缀非法或缺失时返回 null。
 */
export function parseDistKey(token: string): DistAuth | null {
  const lastDash = token.lastIndexOf("-");
  if (lastDash <= 0) return null; // 无 `-` 或前缀为空
  const prefix = token.slice(0, lastDash).toLowerCase();
  const apiKey = token.slice(lastDash + 1);
  if (!apiKey) return null;
  switch (prefix) {
    case "tavily":
      return { protocol: "native", provider: "tavily", apiKey };
    case "exa":
      return { protocol: "native", provider: "exa", apiKey };
    case "searxng-tavily":
      return { protocol: "searxng", provider: "tavily", apiKey };
    default:
      return null;
  }
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

/**
 * 脱敏：保留可识别前缀 + 尾部若干字符，用 .... 省略中间。
 * 带前缀（含 `-`）的 key 保留前缀至首个 `-` 含 `-`，如 tvly-....abcdef；
 * 无前缀（exa/dist 等纯随机）保留前 4 位 + 尾 6 位，如 a1b2....cdef0a。
 * 尾部字符用于区分同前缀的多个 key。
 */
export function maskKey(key: string): string {
  if (key.length <= 12) return "****";
  const dash = key.indexOf("-");
  const prefix = dash >= 0 ? key.slice(0, dash + 1) : key.slice(0, 4);
  return `${prefix}....${key.slice(-6)}`;
}

/**
 * 用量小时桶键（UTC）：'YYYY-MM-DDTHH:00'。后端全部时间口径用 UTC，
 * "今日/最近N小时"边界由前端用小时分段自行组合。
 */
export function hourKey(t: number = Date.now()): string {
  return new Date(t).toISOString().slice(0, 13) + ":00";
}

/** 给定时间点所在 UTC 日的 00:00 小时桶键（服务端内部"今日"口径用）。 */
export function utcTodayStart(t: number = Date.now()): string {
  return new Date(t).toISOString().slice(0, 10) + "T00:00";
}

/**
 * 自动生成 key 备注名：Asia/Shanghai 时间戳 + 4 位随机 hex。
 * 格式：YYYY/MM/DD/HH:MM:SS+RAND，如 2026/08/10/14:30:25+a1b2。
 */
export function autoKeyName(): string {
  const now = new Date();
  const fmt = new Intl.DateTimeFormat("zh-CN", {
    timeZone: "Asia/Shanghai",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hour12: false,
  });
  const parts = fmt.formatToParts(now);
  const get = (type: string) => parts.find((p) => p.type === type)?.value ?? "00";
  const rand = randomToken(2).slice(0, 4);
  return `${get("year")}/${get("month")}/${get("day")}/${get("hour")}:${get("minute")}:${get("second")}+${rand}`;
}

