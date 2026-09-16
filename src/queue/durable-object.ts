// 队列 Durable Object：每 provider 一把独立队列实例（idFromName(provider)）。
// 职责：把"同一时刻突发"的请求串行放行——一次只在途 1 个任务，每个任务（含其内部
// 重试）跑完后隔 intervalMs 再放下一个，从而削峰填谷、把真实上游请求频率压到可调区间。
// drain 兼任三件维护：每个任务前「权重 base 独立刷新（自节流 ≤120s）」、
// 「key 池（KeyPool）每任务前 maybeReload + 任务后 maybeCheckpoint」与
// 队列清空后「兜底 flush（usage + key 池 flushNow 双份）」。
//
// 关键事实（用户已确认）：
//   - 该 DO 同时持有本 provider 的上游 key 池内存权威态（冷却/熔断，见 key-pool.ts）；
//     admin 变更经 `/_internal/sync-keys` 推式重读，另有 60s 陈旧兜底（maybeReload）。
//   - 每个任务 = 一次"对上游的完整处理"（含 searchWithRetry 最多换 MAX_ATTEMPTS 把 key），
//     重试是同一任务的内部动作，不会重新入队/额外吃 3s 间隔。
//   - 等待中任务数达到 maxDepth → 新请求直接 429（拒入，不排队）。
//   - 入队后等待超过 waitBudgetMs → 定时器直接回 429（drain 跳过 settled 项，不烧配额）。
//   - intervalMs / maxDepth / waitBudgetMs 由 KV 运行时配置（cachedQueueConfig），缺省 3000/10/30000。
//   - 连接断开：任务仍未轮到（signal aborted）→ 直接丢弃，不烧上游配额。

import { DurableObject } from "cloudflare:workers";
import { Env } from "../types";
import { Provider } from "../domain";
import { PROVIDERS } from "../providers";
import type { ProviderConfig } from "../providers";
import { runNativeTask } from "../proxy/executors/native";
import { runSearxngTask } from "../proxy/executors/searxng";
import { runReaderTask } from "../proxy/executors/reader";
import { getUsageStore } from "../usage";
import { QueueTask } from "./task";
import { searxngError } from "../adapters/searxng";
import { readerError } from "../adapters/reader";
import { cachedQueueConfig } from "./config";
import { createKeyPool, type KeyPool } from "../key-pool";
import type { QueueConfig } from "./config";

interface QueuedRequest {
  provider: Provider;
  apiKey: string;
  task: QueueTask;
  resolve: (res: Response) => void;
  reject: (err: unknown) => void;
  signal: AbortSignal;
  enteredAt: number;                                  // 入队时刻，用于等待超时判定
  timer: number | null;                               // 等待超时定时器句柄（workers-types: setTimeout → number）
  settled: boolean;                                   // 定时器已回 429（防重复执行上游）
}

/** 构造 429 拒入响应（按线协议渲染错误体 + Retry-After）。深度拒入与排队超时共用。 */
function rateLimitResponse(
  def: ProviderConfig,
  task: QueueTask,
  cfg: QueueConfig,
  msg: string
): Response {
  const res =
    task.kind === "searxng"
      ? searxngError(429, msg)
      : task.kind === "reader"
        ? readerError(429, msg)
        : def.errorBody(429, msg);
  const headers = new Headers(res.headers);
  headers.set("retry-after", String(Math.ceil(cfg.intervalMs / 1000)));
  return new Response(res.body, { status: 429, statusText: res.statusText, headers });
}

export class QueueDO extends DurableObject<Env> {
  private pending: QueuedRequest[] = [];
  private draining = false;
  private config = cachedQueueConfig();
  // 本 provider 的上游 key 池内存权威态（冷却/熔断）。同一 DO 实例恒同 provider，仍按 provider 防御。
  private pool: { provider: Provider; pool: KeyPool } | null = null;

  private ensurePool(provider: Provider): KeyPool {
    if (!this.pool || this.pool.provider !== provider) {
      this.pool = { provider, pool: createKeyPool(this.env, PROVIDERS[provider].upstream) };
    }
    return this.pool.pool;
  }

  async fetch(request: Request): Promise<Response> {
    // admin 变更推式同步：全量重读合并（保留内存冷却）。body 非法/provider 未知 → 400。
    if (new URL(request.url).pathname === "/_internal/sync-keys") {
      const body = (await request.json().catch(() => null)) as { provider?: string } | null;
      if (!body?.provider || !PROVIDERS[body.provider as Provider]) {
        return Response.json({ detail: { error: "bad sync payload" } }, { status: 400 });
      }
      await this.ensurePool(body.provider as Provider).reload(); // 合并重读，保留内存冷却
      return new Response("ok");
    }

    let payload: { provider: Provider; apiKey: string; task: QueueTask };
    try {
      payload = (await request.json()) as typeof payload;
    } catch {
      return Response.json(
        { detail: { error: "malformed queue task" } },
        { status: 400 }
      );
    }

    const def = PROVIDERS[payload.provider];
    if (!def) {
      return Response.json(
        { detail: { error: `unknown provider: ${payload.provider}` } },
        { status: 400 }
      );
    }

    const cfg = await this.config.get(this.env.KV);

    // 关键：capacity 门禁与 push 必须在同一同步块内（中间无 await）。
    // DO 可并发处理多个 subrequest（await 点交错、单线程事件循环），若检查与入队
    // 之间隔了 await，突发请求会在检查后同时入队 → maxDepth 被击穿。此处合并在
    // Promise executor 的同步段里，保证原子（check + push 之间无法被其他 handler 插入）。
    return new Promise<Response>((resolve, reject) => {
      if (this.pending.length >= cfg.maxDepth) {
        // 拒入：等待中已满。错误体按线协议渲染（searxng→{error}；native→provider 官方格式），
        // Retry-After 按当前间隔给调用方退避提示。
        resolve(rateLimitResponse(def, payload.task, cfg,
          `too many queued requests (max ${cfg.maxDepth}); retry later`));
        return;
      }

      const item: QueuedRequest = {
        provider: payload.provider,
        apiKey: payload.apiKey,
        task: payload.task,
        signal: request.signal,
        enteredAt: Date.now(),
        timer: null,
        settled: false,
        resolve: () => {},
        reject: () => {},
      };
      item.resolve = resolve;
      item.reject = reject;
      // 排队等待预算：等待超过 waitBudgetMs 直接 429（不烧上游配额）。定时器在 DO
      // 单线程事件循环里可随 await 正常触发；一旦 drain 开始执行就 clearTimeout，不误杀
      // 任务自身的合法长执行。
      item.timer = setTimeout(() => {
        if (item.settled) return;
        item.settled = true;
        resolve(
          rateLimitResponse(def, payload.task, cfg,
            `request waited too long (max ${cfg.waitBudgetMs}ms); retry later`)
        );
      }, cfg.waitBudgetMs);
      this.pending.push(item);
      this.kick();
    });
  }

  /** 若没有正在运行的放行循环，则启动一个，串行吃队列。 */
  private kick(): void {
    if (this.draining) return;
    this.draining = true;
    void this.drain().finally(() => {
      this.draining = false;
    });
  }

  private async drain(): Promise<void> {
    while (this.pending.length > 0) {
      const cfg = await this.config.get(this.env.KV);
      const item = this.pending.shift()!;
      clearTimeout(item.timer); // 已轮到自己，停掉等待超时（null 时 no-op）
      if (item.settled) continue; // 超时已回 429，不再执行上游（不烧配额）
      // 调用方已断开且尚未轮到：丢弃，不烧上游配额
      if (item.signal.aborted) {
        item.reject(new Error("client disconnected before its queue slot"));
        continue;
      }
      // 权重信号 base 独立刷新（自节流 ≤120s；稳态为缓存 no-op，无网络代价）：
      // 让每个任务的冷启动/周期刷新都先有新底数，emit(init) 里的 readUpstreamWeightSignal
      // 保持 0 D1 往返（权重刷新节奏与 flush 解耦，不再依赖 flush 节流）。
      await getUsageStore(this.env).refreshWeightBase().catch(() => {});
      // key 池冷启动/60s 陈旧兜底重读：每个任务前拉最新 key 列表（合并保留内存冷却）。
      // 失败保留旧内存——冷启动且 D1 挂时 keys 空 → 表现变 503 unavailable（比 502 更合理）。
      const pool = this.ensurePool(item.provider);
      await pool.maybeReload().catch(() => {});
      try {
        const deps = {
          env: this.env,
          executionCtx: { waitUntil: (p: Promise<unknown>) => void this.ctx.waitUntil(p) },
          pool,
        };
        const def = PROVIDERS[item.provider];
        const task = item.task; // 局部捕获，便于 discriminated union 窄化
        const res =
          task.kind === "native"
            ? await runNativeTask(deps, def, item.apiKey, task)
            : task.kind === "reader"
              ? await runReaderTask(deps, def, item.apiKey, task)
              : await runSearxngTask(deps, def, item.apiKey, task);
        item.resolve(res);
      } catch (err) {
        item.reject(err);
      }
      // 每个任务结束后：低频 checkpoint 冷却（dirty 条数/30s 节流；失败静默保留 dirty）。
      await pool.maybeCheckpoint().catch(() => {});
      // 每个任务结束后（含其内部重试），隔 intervalMs 再放下一个。
      await this.sleepMs(Math.max(1, cfg.intervalMs));
    }
    // 队列清空兜底 flush：防 pending 长期悬空被 DO evict 丢。每轮 drain 至多一次，写批很小。
    await getUsageStore(this.env).flushNow().catch(() => {});
    // key 池兜底：无条件落库剩余 dirty 冷却。
    if (this.pool) await this.pool.pool.flushNow().catch(() => {});
  }

  private sleepMs(ms: number): Promise<void> {
    return new Promise((r) => setTimeout(r, ms));
  }
}
