// 熔断/冷却参数配置（可运行时调整）：postUseCooldownSec（每次使用后固定冷却）与
// breakerBaseSec（非429失败指数退避的基数）。单位为秒。存 KV `breaker_config`（JSON），
// 缺省回退 DEFAULT —— 改 KV 即生效，无需重新部署。
// circuit-breaker 每次记录前经 cachedBreakerConfig 读取（短 TTL 缓存），变更 ≤ cacheTtl 生效。

export interface BreakerConfig {
  /** 每次使用 key 后（无论成败）的冷却时长（秒）。默认 10s。 */
  postUseCooldownSec: number;
  /** 熔断冷却基数：首次失败冷却 = BASE × 2^1 = 20min，后续指数增长。默认 600s = 10min。 */
  breakerBaseSec: number;
  /** 401/403 疑似失效冷却：key 级鉴权错误后固定冷却（超过即重试一次）。默认 43200s = 12h。 */
  invalidCooldownSec: number;
}

export const DEFAULT_BREAKER_CONFIG: BreakerConfig = {
  postUseCooldownSec: 10,
  breakerBaseSec: 600,
  invalidCooldownSec: 43200,
};

const CONFIG_KEY = "breaker_config";
const CACHE_TTL_MS = 3000;

/** 从 KV 读取配置；未写/损坏时回退默认值。postUse 允许 0（= 关闭每次冷却），其余只校验有限且为正。 */
export async function readBreakerConfig(kv: KVNamespace): Promise<BreakerConfig> {
  let raw: unknown = null;
  try {
    raw = await kv.get(CONFIG_KEY, "json");
  } catch {
    raw = null;
  }
  if (!raw || typeof raw !== "object") return { ...DEFAULT_BREAKER_CONFIG };
  const o = raw as Record<string, unknown>;
  const postUseCooldownSec =
    typeof o.postUseCooldownSec === "number" ? o.postUseCooldownSec : Number.NaN;
  const breakerBaseSec =
    typeof o.breakerBaseSec === "number" ? o.breakerBaseSec : Number.NaN;
  const invalidCooldownSec =
    typeof o.invalidCooldownSec === "number" ? o.invalidCooldownSec : Number.NaN;
  return {
    postUseCooldownSec:
      Number.isFinite(postUseCooldownSec) && postUseCooldownSec >= 0
        ? Math.round(postUseCooldownSec)
        : DEFAULT_BREAKER_CONFIG.postUseCooldownSec,
    breakerBaseSec:
      Number.isFinite(breakerBaseSec) && breakerBaseSec > 0
        ? Math.round(breakerBaseSec)
        : DEFAULT_BREAKER_CONFIG.breakerBaseSec,
    invalidCooldownSec:
      Number.isFinite(invalidCooldownSec) && invalidCooldownSec > 0
        ? Math.round(invalidCooldownSec)
        : DEFAULT_BREAKER_CONFIG.invalidCooldownSec,
  };
}

/** 覆盖写配置（全部字段）。调用方（admin）负责校验与错误提示。 */
export async function writeBreakerConfig(
  kv: KVNamespace,
  cfg: BreakerConfig
): Promise<void> {
  await kv.put(CONFIG_KEY, JSON.stringify(cfg));
}

export interface BreakerConfigCache {
  /** 读取配置，带 TTL 缓存：TTL 内命中内存值，避免每次记录一次 KV IO。 */
  get(kv: KVNamespace): Promise<BreakerConfig>;
  /** 清空缓存（写配置后主动失效，保证读后即见最新值）。 */
  invalidate(): void;
}

/** 供 circuit-breaker 持有的配置读取器：TTL 缓存 + 写后失效。 */
export function cachedBreakerConfig(ttlMs: number = CACHE_TTL_MS): BreakerConfigCache {
  let cached: { cfg: BreakerConfig; at: number } | null = null;
  return {
    async get(kv: KVNamespace): Promise<BreakerConfig> {
      const now = Date.now();
      if (cached && now - cached.at < ttlMs) return cached.cfg;
      const cfg = await readBreakerConfig(kv);
      cached = { cfg, at: now };
      return cfg;
    },
    invalidate(): void {
      cached = null;
    },
  };
}
