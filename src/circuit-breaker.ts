// 基础设施层·熔断冷却策略。
// 三层冷却共用一个 cooldown_until 字段，写入时取较大值：
//   1. Post-use 冷却：每次使用后（无论成败）固定时长（默认 10s，可调）
//   2. 熔断冷却：仅 server-error 族失败后（5xx / 网络 / 2xx-不可用），指数退避 = base × 2^连续失败次数（base 默认 10min，可调）
//   3. 疑似失效冷却：每次 401/403 后固定 invalidCooldownSec（默认 12h，可调），不碰连续失败计数
// 成功时连续失败归零，冷却仅保留 post-use 时长。
// 连续失败计数与冷却权威态在 key 池（KeyPool，每 provider 一把 QueueDO 内存）；
// 10min 空窗（BREAKER_TTL_MS）用内存 updated_at 判定。本模块不再直接读 D1，
// 只经由 pool 读写内存（D1 由池的"合并 reload + 低频 checkpoint"负责）。
// 时长参数来自 KV 运行时配置（breaker_config，基础配置留 KV），经模块级 TTL 缓存读取，≤ cacheTtl 生效。

import type { Env } from "./types";
import type { KeyPool } from "./key-pool";
import { cachedBreakerConfig } from "./breaker-config";

const BREAKER_TTL_MS = 10 * 60 * 1000; // 连续失败计数空窗 10 分钟后自动归零
const config = cachedBreakerConfig();

/**
 * 成功响应：post-use 冷却 + 连续失败计数归零。写 target 仅为内存池，无 IO 失败路径。
 */
export async function recordUpstreamSuccess(
  env: Env,
  pool: KeyPool,
  id: string,
  now: number = Date.now()
): Promise<void> {
  const { postUseCooldownSec } = await config.get(env.KV);
  pool.applyBreakerOutcome(id, now + postUseCooldownSec * 1000, 0, now);
}

/**
 * server-error 族失败：连续失败 +1（10min 窗口内），指数退避冷却 = max(postUse, base × 2^consecutive)。
 */
export async function recordUpstreamFailure(
  env: Env,
  pool: KeyPool,
  id: string,
  now: number = Date.now()
): Promise<void> {
  const { postUseCooldownSec, breakerBaseSec } = await config.get(env.KV);
  const cur = pool.getBreakerState(id);
  // 窗口外（距上次 > BREAKER_TTL_MS）视为已恢复，重新从 1 计。
  const consecutive = cur && now - cur.updated_at < BREAKER_TTL_MS ? cur.consecutive + 1 : 1;
  const cooldownMs = breakerBaseSec * 1000 * Math.pow(2, consecutive);
  const until = now + Math.max(postUseCooldownSec * 1000, cooldownMs);
  pool.applyBreakerOutcome(id, until, consecutive, now);
}

/**
 * rate-limit：仅 post-use 冷却，不碰连续失败计数。
 */
export async function recordUpstreamRateLimit(
  env: Env,
  pool: KeyPool,
  id: string,
  now: number = Date.now()
): Promise<void> {
  const { postUseCooldownSec } = await config.get(env.KV);
  pool.applyBreakerOutcome(id, now + postUseCooldownSec * 1000, null, now);
}

/**
 * auth-error 疑似失效：固定 invalidCooldownSec（默认 12h）长冷却，不碰连续失败计数；
 * 以 post-use 为地板（较长者胜）。到点后重试一次；若成功由 recordUpstreamSuccess 自动回缩并归零。
 */
export async function recordUpstreamInvalid(
  env: Env,
  pool: KeyPool,
  id: string,
  now: number = Date.now()
): Promise<void> {
  const { postUseCooldownSec, invalidCooldownSec } = await config.get(env.KV);
  const until = now + Math.max(postUseCooldownSec, invalidCooldownSec) * 1000;
  pool.applyBreakerOutcome(id, until, null, now);
}
