// 熔断/冷却参数配置（可运行时调整）：postUseCooldownSec（每次使用后固定冷却）与
// breakerBaseSec（server-error 族失败指数退避的基数）。单位为秒。存 KV `breaker_config`（JSON），
// 缺省回退 DEFAULT —— 改 KV 即生效，无需重新部署。
// circuit-breaker 每次记录前经 cachedBreakerConfig 读取（短 TTL 缓存），变更 ≤ cacheTtl 生效。

import { defineKvConfig, type KvConfigCache } from "./kv-config";

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

const breakerConfig = defineKvConfig<BreakerConfig>({
  key: "breaker_config",
  defaults: DEFAULT_BREAKER_CONFIG,
  /** postUse 允许 0（= 关闭每次冷却），其余只校验有限且为正。 */
  parse(o) {
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
  },
});

/** 从 KV 读取配置；未写/损坏时回退默认值。 */
export async function readBreakerConfig(kv: KVNamespace): Promise<BreakerConfig> {
  return breakerConfig.read(kv);
}

/** 覆盖写配置（全部字段）。调用方（admin）负责校验与错误提示。 */
export async function writeBreakerConfig(kv: KVNamespace, cfg: BreakerConfig): Promise<void> {
  await breakerConfig.write(kv, cfg);
}

/** 供 circuit-breaker 持有的配置读取器：TTL 缓存 + 写后失效。 */
export function cachedBreakerConfig(ttlMs?: number): KvConfigCache<BreakerConfig> {
  return breakerConfig.cached(ttlMs);
}