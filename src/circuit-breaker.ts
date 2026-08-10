// 基础设施层·熔断冷却策略。
// 两层冷却共用一个 cooldown_until 字段，写入时取最大值：
//   1. Post-use 冷却：每次使用后（无论成败）固定 5s
//   2. 熔断冷却：每次非429失败后，指数退避 = 60s × 2^连续失败次数
// 成功时连续失败归零，冷却仅保留 5s post-use。
// 读写失败均静默：它是保险机制，不阻塞主流程。

import { POST_USE_COOLDOWN_MS, BREAKER_BASE_MS, UpstreamDef } from "./domain";
import {
  breakerKey,
  readValueStats,
  setUpstreamCooldown,
  writeValueStats,
} from "./storage";

const BREAKER_TTL_SECONDS = 10 * 60; // 连续失败计数空窗 10 分钟后自动归零

/**
 * 成功响应：post-use 5s 冷却 + 连续失败计数归零。
 */
export async function recordUpstreamSuccess(
  kv: KVNamespace,
  def: UpstreamDef,
  id: string,
  now: number = Date.now()
): Promise<void> {
  await setUpstreamCooldown(kv, def, id, now + POST_USE_COOLDOWN_MS).catch(() => {});
  await writeValueStats(kv, breakerKey(id), { consecutive: 0 }, BREAKER_TTL_SECONDS).catch(
    () => {}
  );
}

/**
 * 非429失败：连续失败 +1，指数退避冷却 = max(5s, 60s × 2^consecutive)。
 */
export async function recordUpstreamFailure(
  kv: KVNamespace,
  def: UpstreamDef,
  id: string,
  now: number = Date.now()
): Promise<void> {
  const cur = (await readValueStats(kv, breakerKey(id)).catch(() => ({}))) as Record<
    string,
    number
  >;
  const consecutive = (cur.consecutive ?? 0) + 1;
  const cooldownMs = BREAKER_BASE_MS * Math.pow(2, consecutive);
  const until = now + Math.max(POST_USE_COOLDOWN_MS, cooldownMs);
  await setUpstreamCooldown(kv, def, id, until).catch(() => {});
  await writeValueStats(kv, breakerKey(id), { consecutive }, BREAKER_TTL_SECONDS).catch(
    () => {}
  );
}

/**
 * 429 限流：仅 post-use 5s 冷却，不碰连续失败计数。
 */
export async function recordUpstreamRateLimit(
  kv: KVNamespace,
  def: UpstreamDef,
  id: string,
  now: number = Date.now()
): Promise<void> {
  await setUpstreamCooldown(kv, def, id, now + POST_USE_COOLDOWN_MS).catch(() => {});
}
