// 领域服务·KeySelection：候选过滤与加权选 key（无状态纯函数，零 IO）。
// 从重试 FSM 拆出，供 retry-state-machine 的 emit(init / pick) 使用；
// 权重语义见 CONTEXT.md「权重」——软负载分布调节，健康判断由冷却（硬闸门）负责。

import type { CoreKey } from "../domain";

/** 单个 key 当前是否可用：status=enabled 且未过 cooldown_until。 */
export function isCandidate(k: CoreKey, now: number): boolean {
  return k.status === "enabled" && (k.cooldown_until == null || k.cooldown_until <= now);
}

/**
 * 加权随机：只从 status=enabled、未冷却 且 未被排除的 key 中选择；
 * 权重 = 1 / (该 key 滑动窗口失败数信号 + 1)，即失败越少权重越高（0 失败最高）。
 * statsMap 为空（单选候选时跳过统计）则退化为均匀权重。
 */
export function selectUpstreamKey(
  keys: CoreKey[],
  statsMap: Record<string, number>,
  now: number = Date.now(),
  excludeIds?: Set<string>
): CoreKey | null {
  const candidates = keys.filter(
    (k) => isCandidate(k, now) && (!excludeIds || !excludeIds.has(k.id))
  );
  if (candidates.length === 0) return null;

  const weights = candidates.map((k) => {
    const fail = statsMap[k.id] ?? 0;
    return 1 / (fail + 1);
  });
  const total = weights.reduce((a, b) => a + b, 0);
  let r = Math.random() * total;
  for (let i = 0; i < candidates.length; i++) {
    r -= weights[i];
    if (r <= 0) return candidates[i];
  }
  return candidates[candidates.length - 1];
}
