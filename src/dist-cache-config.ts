// 分发 key 鉴权缓存配置（可运行时调整）：缓存命中避免每次请求读 D1，
// 撤销/禁用的最坏生效延迟由 cacheTtlSec 控制。存 KV `dist_cache_config`（JSON），
// 缺省回退 DEFAULT —— 改 KV 即生效，无需重新部署。
// storage 通过 cachedDistCacheConfig 读取（短 TTL 缓存），变更 ≤ cacheTtl 生效。

import { defineKvConfig, type KvConfigCache } from "./kv-config";

export interface DistCacheConfig {
  /** 鉴权缓存 TTL（秒）。撤销/禁用的最坏生效延迟。默认 300s。 */
  cacheTtlSec: number;
}

export const DEFAULT_DIST_CACHE_CONFIG: DistCacheConfig = { cacheTtlSec: 300 };

const distCacheConfig = defineKvConfig<DistCacheConfig>({
  key: "dist_cache_config",
  defaults: DEFAULT_DIST_CACHE_CONFIG,
  /** 只校验数值有限且为正。 */
  parse(o) {
    const cacheTtlSec = typeof o.cacheTtlSec === "number" ? o.cacheTtlSec : Number.NaN;
    return {
      cacheTtlSec:
        Number.isFinite(cacheTtlSec) && cacheTtlSec > 0
          ? Math.round(cacheTtlSec)
          : DEFAULT_DIST_CACHE_CONFIG.cacheTtlSec,
    };
  },
});

/** 从 KV 读取配置；未写/损坏时回退默认值。 */
export async function readDistCacheConfig(kv: KVNamespace): Promise<DistCacheConfig> {
  return distCacheConfig.read(kv);
}

/** 覆盖写配置（全部字段）。调用方（admin）负责校验与错误提示。 */
export async function writeDistCacheConfig(kv: KVNamespace, cfg: DistCacheConfig): Promise<void> {
  await distCacheConfig.write(kv, cfg);
}

/** 供 storage 持有的配置读取器：TTL 缓存 + 写后失效。 */
export function cachedDistCacheConfig(ttlMs?: number): KvConfigCache<DistCacheConfig> {
  return distCacheConfig.cached(ttlMs);
}