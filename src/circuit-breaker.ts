// 基础设施层·熔断冷却「副作用绑定」（Side-effect binder）：读 KV 配置 + 写 KeyPool。
// 决策（三层冷却数学 / 10min 空窗复位）见 domain-services/breaker-policy.ts 的纯策略
// computeBreakerOutcome；本文件只负责取参、调用策略、落池，无任何冷却算法分支。
// 连续失败计数与冷却权威态在 key 池（KeyPool，每 provider 一把 QueueDO 内存）；
// 时长参数来自 KV 运行时配置（breaker_config），经模块级 TTL 缓存读取，≤ cacheTtl 生效。

import type { Env } from "./types";
import type { KeyPool } from "./key-pool";
import type { RetryClass } from "./domain";
import { cachedBreakerConfig } from "./breaker-config";
import { computeBreakerOutcome } from "./domain-services/breaker-policy";

const config = cachedBreakerConfig();

/**
 * 记录一次上游结果对某 key 的熔断/冷却副作用（写 KeyPool 内存）：
 * 读 KV 配置 → computeBreakerOutcome 算结局 → applyBreakerOutcome 落池。
 * result 与领域事件 cls 同源（"success" | RetryClass）；client-error 不入
 * computeBreakerOutcome（不换 key 不记账），进到由该策略抛错、被订阅者 .catch 兜住。
 */
export async function recordUpstreamOutcome(
  env: Env,
  pool: KeyPool,
  id: string,
  result: RetryClass | "success",
  now: number = Date.now()
): Promise<void> {
  const { postUseCooldownSec, breakerBaseSec, invalidCooldownSec } = await config.get(env.KV);
  const { consecutive, cooldownUntil, cause } = computeBreakerOutcome(
    pool.getBreakerState(id),
    result,
    postUseCooldownSec,
    breakerBaseSec,
    invalidCooldownSec,
    now
  );
  pool.applyBreakerOutcome(id, cooldownUntil, cause, consecutive, now);
}
