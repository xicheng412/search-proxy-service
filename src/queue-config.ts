// 队列参数配置（可运行时调整）：intervalMs（相邻两个任务开始之间的最小间隔）与
// maxDepth（等待中最大任务数，超出对调用方 429）。存 KV `queue_config`（JSON），
// 缺省回退 DEFAULT —— 改 KV 即放开/收紧，无需重新部署。
// DO 每次入队/放行前经 cachedQueueConfig 读取（短 TTL 缓存），参数变更 ≤ cacheTtl 生效。

export interface QueueConfig {
  /** 相邻两个任务开始的最小间隔（毫秒）。默认 3000 = 每 3s 放行一个任务。 */
  intervalMs: number;
  /** 等待中任务数达到此值时，新请求直接 429（拒入，不再入队）。默认 10。 */
  maxDepth: number;
}

export const DEFAULT_QUEUE_CONFIG: QueueConfig = {
  intervalMs: 3000,
  maxDepth: 10,
};

const CONFIG_KEY = "queue_config";
const CACHE_TTL_MS = 3000;

/** 从 KV 读取配置；未写/损坏时回退默认值。只校验数值有限且为正。 */
export async function readQueueConfig(kv: KVNamespace): Promise<QueueConfig> {
  let raw: unknown = null;
  try {
    raw = await kv.get(CONFIG_KEY, "json");
  } catch {
    raw = null;
  }
  if (!raw || typeof raw !== "object") return { ...DEFAULT_QUEUE_CONFIG };
  const o = raw as Record<string, unknown>;
  const intervalMs = typeof o.intervalMs === "number" ? o.intervalMs : Number.NaN;
  const maxDepth = typeof o.maxDepth === "number" ? o.maxDepth : Number.NaN;
  return {
    intervalMs: Number.isFinite(intervalMs) && intervalMs > 0 ? Math.round(intervalMs) : DEFAULT_QUEUE_CONFIG.intervalMs,
    maxDepth: Number.isFinite(maxDepth) && maxDepth > 0 ? Math.floor(maxDepth) : DEFAULT_QUEUE_CONFIG.maxDepth,
  };
}

/** 覆盖写配置（全部字段）。调用方（admin）负责校验与错误提示。 */
export async function writeQueueConfig(
  kv: KVNamespace,
  cfg: QueueConfig
): Promise<void> {
  await kv.put(CONFIG_KEY, JSON.stringify(cfg));
}

export interface QueueConfigCache {
  /** 读取配置，带 TTL 缓存：TTL 内命中内存值，避免每次任务一次 KV IO。 */
  get(kv: KVNamespace): Promise<QueueConfig>;
  /** 清空缓存（写配置后主动失效，保证读后即见最新值）。 */
  invalidate(): void;
}

/** 供 Durable Object 持有的配置读取器：TTL 缓存 + 写后失效。 */
export function cachedQueueConfig(ttlMs: number = CACHE_TTL_MS): QueueConfigCache {
  let cached: { cfg: QueueConfig; at: number } | null = null;
  return {
    async get(kv: KVNamespace): Promise<QueueConfig> {
      const now = Date.now();
      if (cached && now - cached.at < ttlMs) return cached.cfg;
      const cfg = await readQueueConfig(kv);
      cached = { cfg, at: now };
      return cfg;
    },
    invalidate(): void {
      cached = null;
    },
  };
}
