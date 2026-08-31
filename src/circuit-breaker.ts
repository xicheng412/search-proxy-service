// 基础设施层·熔断冷却策略。
// 三层冷却共用一个 cooldown_until 字段，写入时取较大值：
//   1. Post-use 冷却：每次使用后（无论成败）固定时长（默认 10s，可调）
//   2. 熔断冷却：每次非429失败后，指数退避 = base × 2^连续失败次数（base 默认 10min，可调）
//   3. 疑似失效冷却：每次 401/403 后固定 invalidCooldownSec（默认 12h，可调），不碰连续失败计数
// 成功时连续失败归零，冷却仅保留 post-use 时长。
// 读写失败均静默：它是保险机制，不阻塞主流程。
// 时长参数来自 KV 运行时配置（breaker_config，基础配置留 KV），经模块级 TTL 缓存读取，≤ cacheTtl 生效。
// 连续失败状态存 D1 breaker_state；10min 窗口（BREAKER_TTL_SECONDS）用 updated_at 模拟 KV TTL。

import type { Env } from "./types";
import { UpstreamDef } from "./domain";
import { setUpstreamCooldown, readBreakerState, writeBreakerState } from "./storage";
import { cachedBreakerConfig } from "./breaker-config";

const BREAKER_TTL_MS = 10 * 60 * 1000; // 连续失败计数空窗 10 分钟后自动归零
const config = cachedBreakerConfig();

/**
 * 成功响应：post-use 冷却 + 连续失败计数归零。
 */
export async function recordUpstreamSuccess(
  env: Env,
  def: UpstreamDef,
  id: string,
  now: number = Date.now()
): Promise<void> {
  const { postUseCooldownSec } = await config.get(env.KV);
  await setUpstreamCooldown(env, def, id, now + postUseCooldownSec * 1000).catch(() => {});
  await writeBreakerState(env, id, 0, now).catch(() => {});
}

/**
 * 非429失败：连续失败 +1（10min 窗口内），指数退避冷却 = max(postUse, base × 2^consecutive)。
 */
export async function recordUpstreamFailure(
  env: Env,
  def: UpstreamDef,
  id: string,
  now: number = Date.now()
): Promise<void> {
  const { postUseCooldownSec, breakerBaseSec } = await config.get(env.KV);
  const cur = await readBreakerState(env, id).catch(() => null);
  // 窗口外（距上次 > BREAKER_TTL_MS）视为已恢复，重新从 1 计。
  const consecutive = cur && now - cur.updated_at < BREAKER_TTL_MS ? cur.consecutive + 1 : 1;
  const cooldownMs = breakerBaseSec * 1000 * Math.pow(2, consecutive);
  const until = now + Math.max(postUseCooldownSec * 1000, cooldownMs);
  await setUpstreamCooldown(env, def, id, until).catch(() => {});
  await writeBreakerState(env, id, consecutive, now, cur?.created_at ?? now).catch(() => {});
}

/**
 * 429 限流：仅 post-use 冷却，不碰连续失败计数。
 */
export async function recordUpstreamRateLimit(
  env: Env,
  def: UpstreamDef,
  id: string,
  now: number = Date.now()
): Promise<void> {
  const { postUseCooldownSec } = await config.get(env.KV);
  await setUpstreamCooldown(env, def, id, now + postUseCooldownSec * 1000).catch(() => {});
}

/**
 * 401/403 疑似失效：固定 invalidCooldownSec（默认 12h）长冷却，不碰连续失败计数；
 * 以 post-use 为地板（较长者胜）。到点后重试一次；若成功由 recordUpstreamSuccess 自动回缩并归零。
 */
export async function recordUpstreamInvalid(
  env: Env,
  def: UpstreamDef,
  id: string,
  now: number = Date.now()
): Promise<void> {
  const { postUseCooldownSec, invalidCooldownSec } = await config.get(env.KV);
  const until = now + Math.max(postUseCooldownSec, invalidCooldownSec) * 1000;
  await setUpstreamCooldown(env, def, id, until).catch(() => {});
}
