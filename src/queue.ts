// 队列 Durable Object：每 provider 一把独立队列实例（idFromName(provider)）。
// 职责：把"同一时刻突发"的请求串行放行——一次只在途 1 个任务，每个任务（含其内部
// 重试）跑完后隔 intervalMs 再放下一个，从而削峰填谷、把真实上游请求频率压到可调区间。
//
// 关键事实（用户已确认）：
//   - 每个任务 = 一次"对上游的完整处理"（含 searchWithRetry 最多换 MAX_ATTEMPTS 把 key），
//     重试是同一任务的内部动作，不会重新入队/额外吃 3s 间隔。
//   - 等待中任务数达到 maxDepth → 新请求直接 429（拒入，不排队）。
//   - intervalMs / maxDepth 由 KV 运行时配置（cachedQueueConfig），缺省 3000/10。
//   - 连接断开：任务仍未轮到（signal aborted）→ 直接丢弃，不烧上游配额。

import { DurableObject } from "cloudflare:workers";
import { Env } from "./types";
import { Provider } from "./domain";
import { PROVIDERS } from "./providers";
import { runNativeTask, runSearxngTask, QueueTask } from "./proxy";
import { searxngError } from "./adapters/searxng";
import { cachedQueueConfig } from "./queue-config";

interface QueuedRequest {
  provider: Provider;
  apiKey: string;
  task: QueueTask;
  resolve: (res: Response) => void;
  reject: (err: unknown) => void;
  signal: AbortSignal;
}

export class QueueDO extends DurableObject<Env> {
  private pending: QueuedRequest[] = [];
  private draining = false;
  private config = cachedQueueConfig();

  async fetch(request: Request): Promise<Response> {
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
        const msg = `too many queued requests (max ${cfg.maxDepth}); retry later`;
        const res =
          payload.task.kind === "searxng"
            ? searxngError(429, msg)
            : def.errorBody(429, msg);
        const headers = new Headers(res.headers);
        headers.set("retry-after", String(Math.ceil(cfg.intervalMs / 1000)));
        resolve(new Response(res.body, { status: 429, statusText: res.statusText, headers }));
        return;
      }

      const item: QueuedRequest = {
        provider: payload.provider,
        apiKey: payload.apiKey,
        task: payload.task,
        signal: request.signal,
        resolve: () => {},
        reject: () => {},
      };
      item.resolve = resolve;
      item.reject = reject;
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
      // 调用方已断开且尚未轮到：丢弃，不烧上游配额
      if (item.signal.aborted) {
        item.reject(new Error("client disconnected before its queue slot"));
        continue;
      }
      try {
        const deps = {
          env: this.env,
          executionCtx: { waitUntil: (p: Promise<unknown>) => void this.ctx.waitUntil(p) },
        };
        const def = PROVIDERS[item.provider];
        const task = item.task; // 局部捕获，便于 discriminated union 窄化
        const res =
          task.kind === "native"
            ? await runNativeTask(deps, def, item.apiKey, task)
            : await runSearxngTask(deps, def, item.apiKey, task);
        item.resolve(res);
      } catch (err) {
        item.reject(err);
      }
      // 每个任务结束后（含其内部重试），隔 intervalMs 再放下一个。
      await this.sleepMs(Math.max(1, cfg.intervalMs));
    }
  }

  private sleepMs(ms: number): Promise<void> {
    return new Promise((r) => setTimeout(r, ms));
  }
}
