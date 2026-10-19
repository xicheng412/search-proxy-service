// 基础设施层·KV 运行时参数配置的共用骨架（读 / 写 / 短 TTL 缓存）。
// 三份配置（breaker / queue / dist-cache）只声明 KV key、默认值与逐字段校验，
// 其余"kv.get(json) → 损坏/缺省回退 → TTL 缓存"流程在这里统一。
// 校验仍留在各配置文件：字段允许范围不同（如 postUseCooldownSec 允许 0）。
// 变更生效延迟 = TTL（默认 3s）；`invalidate()` 保留给写后主动失效。

export interface KvConfigCache<T> {
  /** 读取配置，带 TTL 缓存：TTL 内命中内存值，避免每次热路径一次 KV IO。 */
  get(kv: KVNamespace): Promise<T>;
  /** 清空缓存（写配置后主动失效）。 */
  invalidate(): void;
}

export interface KvConfig<T> {
  read(kv: KVNamespace): Promise<T>;
  write(kv: KVNamespace, cfg: T): Promise<void>;
  cached(ttlMs?: number): KvConfigCache<T>;
}

export function defineKvConfig<T extends object>(opts: {
  key: string;
  defaults: T;
  /** 把 KV 里的原始对象规整成配置值；缺省/损坏时调用方自行回退 defaults。 */
  parse(raw: Record<string, unknown>): T;
  ttlMs?: number;
}): KvConfig<T> {
  const ttlMs = opts.ttlMs ?? 3000;

  async function read(kv: KVNamespace): Promise<T> {
    let raw: unknown = null;
    try {
      raw = await kv.get(opts.key, "json");
    } catch {
      raw = null;
    }
    if (!raw || typeof raw !== "object") return { ...opts.defaults };
    return opts.parse(raw as Record<string, unknown>);
  }

  async function write(kv: KVNamespace, cfg: T): Promise<void> {
    await kv.put(opts.key, JSON.stringify(cfg));
  }

  function cached(cacheTtlMs: number = ttlMs): KvConfigCache<T> {
    let cachedValue: { cfg: T; at: number } | null = null;
    return {
      async get(kv: KVNamespace): Promise<T> {
        const now = Date.now();
        if (cachedValue && now - cachedValue.at < cacheTtlMs) return cachedValue.cfg;
        const cfg = await read(kv);
        cachedValue = { cfg, at: now };
        return cfg;
      },
      invalidate(): void {
        cachedValue = null;
      },
    };
  }

  return { read, write, cached };
}