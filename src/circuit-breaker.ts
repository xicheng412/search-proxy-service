// 基础设施层·熔断冷却策略。
// 三层冷却共用一个 cooldown_until 字段，写入时取较大值：
//   1. Post-use 冷却：每次使用后（无论成败）固定时长（默认 5s，可调）
//   2. 熔断冷却：每次非429失败后，指数退避 = base × 2^连续失败次数（base 默认 60s，可调）
//   3. 疑似失效冷却：每次 401/403 后固定 invalidCooldownMs（默认 12h，可调），不碰连续失败计数
// 成功时连续失败归零，冷却仅保留 post-use 时长。
// 读写失败均静默：它是保险机制，不阻塞主流程。
// 时长参数来自 KV 运行时配置（breaker_config），经模块级 TTL 缓存读取，≤ cacheTtl 生效。

import { UpstreamDef } from "./domain";
import {
  breakerKey,
  readValueStats,
  setUpstreamCooldown,
  writeValueStats,
} from "./storage";
import { cachedBreakerConfig } from "./breaker-config";

const BREAKER_TTL_SECONDS = 10 * 60; // 连续失败计数空窗 10 分钟后自动归零
const config = cachedBreakerConfig();

/**
 * 成功响应：post-use 冷却 + 连续失败计数归零。
 */
export async function recordUpstreamSuccess(
  kv: KVNamespace,
  def: UpstreamDef,
  id: string,
  now: number = Date.now()
): Promise<void> {
  const { postUseCooldownMs } = await config.get(kv);
  await setUpstreamCooldown(kv, def, id, now + postUseCooldownMs).catch(() => {});
  await writeValueStats(kv, breakerKey(id), { consecutive: 0 }, BREAKER_TTL_SECONDS).catch(
    () => {}
  );
}

/**
 * 非429失败：连续失败 +1，指数退避冷却 = max(postUse, base × 2^consecutive)。
 */
export async function recordUpstreamFailure(
  kv: KVNamespace,
  def: UpstreamDef,
  id: string,
  now: number = Date.now()
): Promise<void> {
  const { postUseCooldownMs, breakerBaseMs } = await config.get(kv);
  const cur = (await readValueStats(kv, breakerKey(id)).catch(() => ({}))) as Record<
    string,
    number
  >;
  const consecutive = (cur.consecutive ?? 0) + 1;
  const cooldownMs = breakerBaseMs * Math.pow(2, consecutive);
  const until = now + Math.max(postUseCooldownMs, cooldownMs);
  await setUpstreamCooldown(kv, def, id, until).catch(() => {});
  await writeValueStats(kv, breakerKey(id), { consecutive }, BREAKER_TTL_SECONDS).catch(
    () => {}
  );
}

/**
 * 429 限流：仅 post-use 冷却，不碰连续失败计数。
 */
export async function recordUpstreamRateLimit(
  kv: KVNamespace,
  def: UpstreamDef,
  id: string,
  now: number = Date.now()
): Promise<void> {
  const { postUseCooldownMs } = await config.get(kv);
  await setUpstreamCooldown(kv, def, id, now + postUseCooldownMs).catch(() => {});
}

/**
 * 401/403 疑似失效：固定 invalidCooldownMs（默认 12h）长冷却，不碰连续失败计数。
 * 到点后重试一次；若成功由 recordUpstreamSuccess 自动回缩并归零。
 */
export async function recordUpstreamInvalid(
  kv: KVNamespace,
  def: UpstreamDef,
  id: string,
  now: number = Date.now()
): Promise<void> {
  const { invalidCooldownMs } = await config.get(kv);
  await setUpstreamCooldown(kv, def, id, now + invalidCooldownMs).catch(() => {});
}
