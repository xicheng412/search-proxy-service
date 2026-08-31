// 分发 key 鉴权缓存配置（可运行时调整）：缓存命中避免每次请求读 D1，
// 撤销/禁用的最坏生效延迟由 cacheTtlSec 控制。存 KV `dist_cache_config`（JSON），
// 缺省回退 DEFAULT —— 改 KV 即生效，无需重新部署。
// storage 通过 cachedDistCacheConfig 读取（短 TTL 缓存），变更 ≤ cacheTtl 生效。

export interface DistCacheConfig {
  /** 鉴权缓存 TTL（秒）。撤销/禁用的最坏生效延迟。默认 300s。 */
  cacheTtlSec: number;
}

export const DEFAULT_DIST_CACHE_CONFIG: DistCacheConfig = { cacheTtlSec: 300 };

const CONFIG_KEY = "dist_cache_config";
const CACHE_TTL_MS = 3000;

/** 从 KV 读取配置；未写/损坏时回退默认值。只校验数值有限且为正。 */
export async function readDistCacheConfig(kv: KVNamespace): Promise<DistCacheConfig> {
  let raw: unknown = null;
  try {
    raw = await kv.get(CONFIG_KEY, "json");
  } catch {
    raw = null;
  }
  if (!raw || typeof raw !== "object") return { ...DEFAULT_DIST_CACHE_CONFIG };
  const o = raw as Record<string, unknown>;
  const cacheTtlSec = typeof o.cacheTtlSec === "number" ? o.cacheTtlSec : Number.NaN;
  return {
    cacheTtlSec:
      Number.isFinite(cacheTtlSec) && cacheTtlSec > 0
        ? Math.round(cacheTtlSec)
        : DEFAULT_DIST_CACHE_CONFIG.cacheTtlSec,
  };
}

/** 覆盖写配置（全部字段）。调用方（admin）负责校验与错误提示。 */
export async function writeDistCacheConfig(
  kv: KVNamespace,
  cfg: DistCacheConfig
): Promise<void> {
  await kv.put(CONFIG_KEY, JSON.stringify(cfg));
}

export interface DistCacheConfigCache {
  /** 读取配置，带 TTL 缓存：TTL 内命中内存值，避免每次鉴权一次 KV IO。 */
  get(kv: KVNamespace): Promise<DistCacheConfig>;
  /** 清空缓存（写配置后主动失效，保证读后即见最新值）。 */
  invalidate(): void;
}

/** 供 storage 持有的配置读取器：TTL 缓存 + 写后失效。 */
export function cachedDistCacheConfig(
  ttlMs: number = CACHE_TTL_MS
): DistCacheConfigCache {
  let cached: { cfg: DistCacheConfig; at: number } | null = null;
  return {
    async get(kv: KVNamespace): Promise<DistCacheConfig> {
      const now = Date.now();
      if (cached && now - cached.at < ttlMs) return cached.cfg;
      const cfg = await readDistCacheConfig(kv);
      cached = { cfg, at: now };
      return cfg;
    },
    invalidate(): void {
      cached = null;
    },
  };
}
