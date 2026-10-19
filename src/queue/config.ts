// 队列参数配置（可运行时调整）：intervalMs（相邻两个任务开始之间的最小间隔）、
// maxDepth（等待中最大任务数，超出对调用方 429）与 waitBudgetMs（排队等待上限，
// 入队超时直接 429）。存 KV `queue_config`（JSON），缺省回退 DEFAULT —— 改 KV 即放开/收紧，无需重新部署。
// DO 每次入队/放行前经 cachedQueueConfig 读取（短 TTL 缓存），参数变更 ≤ cacheTtl 生效。

import { defineKvConfig, type KvConfigCache } from "../kv-config";

export interface QueueConfig {
  /** 相邻两个任务开始的最小间隔（毫秒）。默认 3000 = 每 3s 放行一个任务。 */
  intervalMs: number;
  /** 等待中任务数达到此值时，新请求直接 429（拒入，不再入队）。默认 10。 */
  maxDepth: number;
  /** 排队等待上限（ms）：任务入队后等待超过即直接 429 拒入。默认 30000 = 30s。 */
  waitBudgetMs: number;
}

export const DEFAULT_QUEUE_CONFIG: QueueConfig = {
  intervalMs: 3000,
  maxDepth: 10,
  waitBudgetMs: 30000,
};

const queueConfig = defineKvConfig<QueueConfig>({
  key: "queue_config",
  defaults: DEFAULT_QUEUE_CONFIG,
  /** 只校验数值有限且为正。 */
  parse(o) {
    const intervalMs = typeof o.intervalMs === "number" ? o.intervalMs : Number.NaN;
    const maxDepth = typeof o.maxDepth === "number" ? o.maxDepth : Number.NaN;
    const waitBudgetMs = typeof o.waitBudgetMs === "number" ? o.waitBudgetMs : Number.NaN;
    return {
      intervalMs:
        Number.isFinite(intervalMs) && intervalMs > 0
          ? Math.round(intervalMs)
          : DEFAULT_QUEUE_CONFIG.intervalMs,
      maxDepth:
        Number.isFinite(maxDepth) && maxDepth > 0
          ? Math.floor(maxDepth)
          : DEFAULT_QUEUE_CONFIG.maxDepth,
      waitBudgetMs:
        Number.isFinite(waitBudgetMs) && waitBudgetMs > 0
          ? Math.round(waitBudgetMs)
          : DEFAULT_QUEUE_CONFIG.waitBudgetMs,
    };
  },
});

/** 从 KV 读取配置；未写/损坏时回退默认值。 */
export async function readQueueConfig(kv: KVNamespace): Promise<QueueConfig> {
  return queueConfig.read(kv);
}

/** 覆盖写配置（全部字段）。调用方（admin）负责校验与错误提示。 */
export async function writeQueueConfig(kv: KVNamespace, cfg: QueueConfig): Promise<void> {
  await queueConfig.write(kv, cfg);
}

/** 供 Durable Object 持有的配置读取器：TTL 缓存 + 写后失效。 */
export function cachedQueueConfig(ttlMs?: number): KvConfigCache<QueueConfig> {
  return queueConfig.cached(ttlMs);
}