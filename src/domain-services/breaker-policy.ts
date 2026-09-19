// 领域服务·BreakerPolicy：熔断/冷却纯策略（无状态纯函数，零 IO）。
// 三层冷却共用一个 cooldown_until 字段，写入时取较大值：
//   1. Post-use 冷却：每次使用后（无论成败）固定时长（默认 10s，可调）
//   2. 熔断冷却：仅 server-error 族失败后（5xx / 网络 / 2xx-不可用），指数退避 = base × 2^连续失败次数（base 默认 10min，可调）
//   3. 疑似失效冷却：每次 401/403 后固定 invalidCooldownSec（默认 12h，可调），不碰连续失败计数
// 成功时连续失败归零，冷却仅保留 post-use 时长。
// client-error 不入本策略（不换 key 不记账），进到即接线错误。
// 决策与 I/O 分离：本文件只算结局，写入 KeyPool / 读 KV 配置是 circuit-breaker.ts 的
// 副作用绑定职责（10min 空窗用内存 updated_at 判定，由本策略按 now 计算）。

import type { RetryClass } from "../domain";

/** 熔断连续计数（KeyPool 内存态）：仅内存权威，不落库（重启用 0，安全方向）。 */
export interface BreakerState {
  consecutive: number;
  updated_at: number;
  created_at: number;
}

/** 一次上游结果对某 key 的冷却决策（值对象）：consecutive=null 表示不碰原有计数。 */
export interface BreakerOutcome {
  consecutive: number | null;
  cooldownUntil: number;
}

/** 连续失败计数空窗 10 分钟后自动归零（窗口外失败视为已恢复，从 1 重计）。 */
export const BREAKER_TTL_MS = 10 * 60 * 1000;

/**
 * 算一次上游结果对某 key 的冷却结局（不落任何状态，只算）。
 * @param cur 该 key 当前熔断计数（null = 尚无记录）
 * @param result 结果族（success 为成功态；client-error 不应进本函数）
 * @param postUseSec post-use 冷却秒数（每次使用后固定，可 0=关闭）
 * @param baseSec 熔断退避基数秒数（首次失败冷却 = base × 2^1）
 * @param invalidSec 疑似失效固定冷却秒数（auth-error）
 * @param now 当前时刻（ms）
 * @returns consecutive：要写入的连续失败计数（null = 不碰计数）；cooldownUntil：冷却截止时刻
 */
export function computeBreakerOutcome(
  cur: BreakerState | null,
  result: RetryClass | "success",
  postUseSec: number,
  baseSec: number,
  invalidSec: number,
  now: number
): BreakerOutcome {
  switch (result) {
    case "success":
      // 成功：连续失败归零，冷却仅保留 post-use 时长。
      return { consecutive: 0, cooldownUntil: now + postUseSec * 1000 };
    case "rate-limit":
      // 仅 post-use 冷却，不碰连续失败计数（null = 沿用现有计数）。
      return { consecutive: null, cooldownUntil: now + postUseSec * 1000 };
    case "auth-error":
      // 疑似失效固定长冷却，以 post-use 为地板（较长者胜）；不碰连续失败计数。
      return { consecutive: null, cooldownUntil: now + Math.max(postUseSec, invalidSec) * 1000 };
    case "server-error": {
      // 窗口外（距上次 > BREAKER_TTL_MS）视为已恢复，重新从 1 计。
      const consecutive =
        cur && now - cur.updated_at < BREAKER_TTL_MS ? cur.consecutive + 1 : 1;
      const cooldownMs = baseSec * 1000 * Math.pow(2, consecutive);
      return { consecutive, cooldownUntil: now + Math.max(postUseSec * 1000, cooldownMs) };
    }
    default:
      // client-error：确定性客户端错误，不换 key、不需冷却、不记账——进熔断策略是接线错误。
      throw new Error(`computeBreakerOutcome: unexpected result ${result}`);
  }
}
