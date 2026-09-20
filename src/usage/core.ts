// 基础设施层·日用量统计模块的"写堡垒"（原 usage-store.ts 的写侧拆出）。
// 职责：把"每次调用/结果的记账"先在内存累积，再按节流策略合并写回 D1。
// 写侧是共享一份状态的顺序管道：pending 缓冲 + flush 防重入 + 双阈值节流，
// 无"产品集合"可言，故不改读侧拆分（reads/）。
// 精度契约（近似值）：同一实例内 record* 后立即 Read 可见（各 read 产品叠加本 pending）；
// 跨实例最多延迟「≥30min 或 ≥256 条」（双阈值，见 flushSoon）；队列清空时兜底 flush
// （见 durable-object.ts drain）；isolate 回收时未 flush 增量丢失 ≤ 上述阈值区间。
// flush 写失败静默，读失败按 0 处理，绝不阻塞主流程。
// 用量按 UTC 小时桶落库（usage_counts）；success/fail 二选一，calls = 二者之和（派生）。
// 对外仅暴露三种原语：record*（记账）、flush*（落库调度）、visitPending（读侧叠加读）与
// onFlushed（flush 落库后的钩子，组合根用它刷新权重信号快照）。

import type { Env } from "../types";
import type { Provider } from "../domain";
import { mergeUsage, type UsageIncrement, type UsageKind } from "../storage/usage";

type Result = "success" | "fail";

export interface PendingFilter {
  /** 仅匹配该 kind 的 pending 条目。 */
  kind?: UsageKind;
  /** 仅匹配该 scope 的 pending 条目。 */
  scope?: string;
  /** 仅匹配 hour >= minHour 的 pending 条目（字符串比较，与原 `hour < minHour` 跳跃一致）。 */
  minHour?: string;
}

export interface PendingEntry {
  kind: UsageKind;
  scope: string;
  provider: string | null; // dist 无 provider 维度：解包时把空串归一为 null
  hour: string;
  success: number;
  fail: number;
}

export interface CoreOpts {
  flushIntervalMs?: number;
  flushMaxPending?: number;
}

export interface UsageCore {
  /** 记一次上游结果（成功/失败）——纯内存累加，0 IO。 */
  recordUpstreamResult(id: string, provider: Provider, hour: string, result: Result): void;
  /** 记一次分发 key 请求到达（无成败维度，仅计数）——纯内存累加，0 IO。 */
  recordDistCall(apiKey: string, hour: string): void;
  /** 节流调度 flush：距上次 ≥interval 且未达条数上限才排入 waitUntil，不阻塞请求。 */
  flushSoon(ctx: { waitUntil(p: Promise<unknown>): void }): void;
  /** 立即落库缓冲中全部增量（队列清空兜底用）：复用 flush 的防重入与批量合并，不改节流时钟。 */
  flushNow(): Promise<void>;
  /** 单遍扫 pending，按 filter 过滤后同步回调每个命中条目（复用单个 entry 对象，零分配）。 */
  visitPending(filter: PendingFilter, cb: (e: PendingEntry) => void): void;
  /** 注册 flush 落库完成钩子（单订阅槽，重复注册覆盖）；失败由回调自身处理。 */
  onFlushed(cb: () => Promise<void>): void;
}

// dist 行无 provider 维度（0004 后 provider 为 NULL）：拼键时归一为空串，upstream 为真实 provider。
const bufKey = (r: Pick<UsageIncrement, "kind" | "scope" | "provider" | "hour">) =>
  `${r.kind}\u0000${r.scope}\u0000${r.provider ?? ""}\u0000${r.hour}`;

export function createCore(env: Env, opts: CoreOpts = {}): UsageCore {
  const flushIntervalMs = opts.flushIntervalMs ?? 30 * 60 * 1000;
  const flushMaxPending = opts.flushMaxPending ?? 256;

  // ---- 写堡垒状态（每个 core 实例独立；一个 isolate 一份）----
  const pending = new Map<string, { success: number; fail: number }>();
  let lastFlushAt = 0;
  let flushing = false;
  // 单订阅槽：flush 落库后通知组合根（权重信号快照刷新）；重复注册覆盖。
  let flushedCb: (() => Promise<void>) | null = null;

  async function flush(): Promise<void> {
    if (flushing || pending.size === 0) return;
    flushing = true;
    const batch = new Map(pending);
    pending.clear();
    try {
      const rows: UsageIncrement[] = [];
      for (const [key, v] of batch) {
        const [kind, scope, provider, hour] = key.split("\u0000");
        rows.push({
          kind: kind as UsageIncrement["kind"],
          scope,
          provider,
          hour,
          success: v.success,
          fail: v.fail,
        });
      }
      await mergeUsage(env, rows);
      // flush 已跑在 waitUntil（后台）：顺带刷新信号快照，不阻塞请求。
      await flushedCb?.().catch(() => {});
    } catch {
      // 写失败静默：统计不阻塞主流程
    } finally {
      flushing = false;
    }
  }

  function flushSoon(ctx: { waitUntil(p: Promise<unknown>): void }): void {
    if (pending.size === 0) return;
    const now = Date.now();
    // 双阈值：距上次 ≥ interval（默认为 30min 小时桶，大致统计）或缓冲达到条数上限即落库；
    // 条数兜底防长驻 isolate 的 pending 无界增长。
    if (now - lastFlushAt < flushIntervalMs && pending.size < flushMaxPending) return;
    lastFlushAt = now;
    ctx.waitUntil(flush().catch(() => {}));
  }

  /** 公开壳：立即落库缓冲中全部增量（队列清空兜底用）。复用 flush 的防重入与 mergeUsage
   *  批量；不改 lastFlushAt——调用点仅在 pending 清空后，无需节流。写失败静默。 */
  async function flushNow(): Promise<void> {
    await flush().catch(() => {});
  }

  function recordUpstreamResult(
    id: string,
    provider: Provider,
    hour: string,
    result: Result
  ): void {
    const key = bufKey({ kind: "upstream", scope: id, provider, hour });
    const cur = pending.get(key) ?? { success: 0, fail: 0 };
    if (result === "success") cur.success += 1;
    else cur.fail += 1;
    pending.set(key, cur);
  }

  function recordDistCall(apiKey: string, hour: string): void {
    // dist 无 provider 维度：provider 恒 null（0004 起不落哨兵值）。
    // 到达即 +1：恒记 success（fail 恒 0；calls = success + fail 派生，不变）。
    const key = bufKey({ kind: "dist", scope: apiKey, provider: null, hour });
    const cur = pending.get(key) ?? { success: 0, fail: 0 };
    cur.success += 1;
    pending.set(key, cur);
  }

  function visitPending(filter: PendingFilter, cb: (e: PendingEntry) => void): void {
    // 单遍扫 pending；复用单个 entry 对象（热路径——权重信号每请求——不得分配）。
    const entry: PendingEntry = {
      kind: "upstream",
      scope: "",
      provider: null,
      hour: "",
      success: 0,
      fail: 0,
    };
    for (const [k, v] of pending) {
      const [kind, scope, provider, hour] = k.split("\u0000");
      if (filter.kind !== undefined && filter.kind !== (kind as UsageKind)) continue;
      if (filter.scope !== undefined && filter.scope !== scope) continue;
      if (filter.minHour !== undefined && hour < filter.minHour) continue;
      entry.kind = kind as UsageKind;
      entry.scope = scope;
      // dist 行 provider 为空串：归一为 null，与读侧 "无 provider 维度" 的口径一致。
      entry.provider = provider === "" ? null : provider;
      entry.hour = hour;
      entry.success = v.success;
      entry.fail = v.fail;
      cb(entry);
    }
  }

  function onFlushed(cb: () => Promise<void>): void {
    flushedCb = cb;
  }

  return {
    recordUpstreamResult,
    recordDistCall,
    flushSoon,
    flushNow,
    visitPending,
    onFlushed,
  };
}
