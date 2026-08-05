// 基础设施层·熔断续流策略。
// 读连续失败计数 -> 达到阈值写冷却并清零。与统计无关；数据落 KV（低频、
// 需跨实例可见，故不走缓冲）。读写失败均静默：它是保险机制，不阻塞主流程。

import { COOLDOWN_MS, COOLDOWN_THRESHOLD, UpstreamDef } from "./domain";
import {
  breakerKey,
  readValueStats,
  setUpstreamCooldown,
  writeValueStats,
} from "./storage";

const BREAKER_TTL_SECONDS = 10 * 60; // 连续失败计数空窗 10 分钟后自动归零

/**
 * 记录一次失败：连续失败计数 +1；若达到阈值，为该 key 设置冷却
 * （cooldown_until = now + COOLDOWN_MS）并重置连续计数。
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
  const writeBreaker = (count: number) =>
    writeValueStats(kv, breakerKey(id), { consecutive: count }, BREAKER_TTL_SECONDS).catch(
      () => {}
    );
  if (consecutive >= COOLDOWN_THRESHOLD) {
    await setUpstreamCooldown(kv, def, id, now + COOLDOWN_MS).catch(() => {});
    await writeBreaker(0);
  } else {
    await writeBreaker(consecutive);
  }
}

/** 记录一次成功：重置连续失败计数。 */
export async function recordUpstreamSuccess(kv: KVNamespace, id: string): Promise<void> {
  await writeValueStats(kv, breakerKey(id), { consecutive: 0 }, BREAKER_TTL_SECONDS).catch(
    () => {}
  );
}
