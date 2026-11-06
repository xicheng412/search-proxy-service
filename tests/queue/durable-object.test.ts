// QueueDO 控制面单测：直接实例化 DurableObject 子类（不经 workerd），
// 假 DurableObjectState(ctx.waitUntil) + 假 Env + vi.stubGlobal("fetch") 拦截上游。
// 每用例 vi.resetModules()+动态 import：隔离 usage/event bus/activePools 等模块级单例。
// 假 KV 的 queue_config 用小值（默认 intervalMs=3000 会让 drain 每任务真睡 3s）。

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import type { Env } from "../../src/types";
import { makeConstantD1 } from "../helpers/fake-d1";

const keyRow = (id: string, over: Record<string, unknown> = {}) => ({
  id,
  key: "tvly-" + id,
  name: "",
  status: "enabled",
  cooldown_until: null,
  suspended_cause: null,
  created_at: 1,
  ...over,
});

function makeEnv(
  rows: Record<string, unknown>[] = [],
  cfg: Record<string, number> = {}
) {
  const queueCfg = { intervalMs: 1, maxDepth: 10, waitBudgetMs: 30_000, ...cfg };
  // breaker_config postUseCooldownSec=0：成功不施加 10s post-use 冷却，
  // 否则下一个排队任务会经 FSM init:cooling 真睡 10s（拖垮 maxDepth 用例）。
  const breakerCfg = { postUseCooldownSec: 0, breakerBaseSec: 600, invalidCooldownSec: 43_200 };
  const d1 = makeConstantD1(rows);
  const env = {
    DB: d1.db,
    KV: {
      get: async (key: string) =>
        key === "queue_config" ? queueCfg : key === "breaker_config" ? breakerCfg : null,
      put: async () => {},
    },
    QUEUE: {} as never,
    ADMIN_PASSWORD: "x",
    PUBLIC_BASE_URL: "https://proxy.example",
  } as unknown as Env;
  return { env, d1, queueCfg };
}

const taskPayload = (provider = "tavily", apiKey = "api-x") => ({
  provider,
  apiKey,
  task: {
    kind: "native",
    path: "/search",
    body: "{}",
    contentType: "application/json",
  },
});

// QueueDO.fetch 只读 request.url / request.json() / request.signal：
// 用最小假 Request，避免 Request body 被 abort 时 json() 抛错。
function fakeRequest(
  payload: unknown,
  opts: { path?: string; signal?: AbortSignal } = {}
): Request {
  return {
    url: "https://queue.internal" + (opts.path ?? "/"),
    json: async () => payload,
    signal: opts.signal ?? new AbortController().signal,
  } as unknown as Request;
}

function deferred<T>() {
  return Promise.withResolvers<T>();
}

async function makeDO(env: Env): Promise<{
  fetch(req: Request): Promise<Response>;
  pending: unknown[];
}> {
  const { QueueDO } = await import("../../src/queue/durable-object");
  return new QueueDO({ waitUntil: () => {} } as never, env) as never;
}

const tick = () => new Promise((r) => setTimeout(r, 0));

async function untilPendingEmpty(instance: { pending: unknown[] }) {
  for (let i = 0; i < 500 && instance.pending.length > 0; i++) await tick();
  expect(instance.pending.length).toBe(0);
}

beforeEach(() => {
  vi.resetModules();
  vi.unstubAllGlobals();
});
afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("QueueDO 控制面", () => {
  it("maxDepth=1：在途 1 + 等待上限之外全部 429，带 retry-after", async () => {
    const { env } = makeEnv([keyRow("k1")], { maxDepth: 1, intervalMs: 1 });
    const instance = await makeDO(env);
    const gate = deferred<Response>();
    vi.stubGlobal("fetch", vi.fn(() => gate.promise));

    const first = instance.fetch(fakeRequest(taskPayload()));
    await untilPendingEmpty(instance);

    const rest = [1, 2, 3, 4].map(() =>
      instance.fetch(fakeRequest(taskPayload()))
    );
    await tick(); // 让 4 个 executor 走完同步 check+push
    gate.resolve(new Response('{"ok":true}', { status: 200 }));

    const results = await Promise.all(rest);
    expect(results.filter((r) => r.status === 429)).toHaveLength(3);
    expect(results.filter((r) => r.status !== 429)).toHaveLength(1);
    expect(
      results.find((r) => r.status === 429)!.headers.get("retry-after")
    ).toBe("1"); // ceil(intervalMs/1000)
    await first;
  });

  it("waitBudgetMs：排队超时 → 429 + retry-after，且不触发上游", async () => {
    const { env } = makeEnv([keyRow("k1")], {
      maxDepth: 10,
      intervalMs: 50,
      waitBudgetMs: 20,
    });
    const instance = await makeDO(env);
    const gate = deferred<Response>();
    const transport = vi.fn(() => gate.promise);
    vi.stubGlobal("fetch", transport);

    const first = instance.fetch(fakeRequest(taskPayload()));
    await untilPendingEmpty(instance);

    const second = instance.fetch(fakeRequest(taskPayload()));
    await new Promise((r) => setTimeout(r, 60)); // 超 waitBudgetMs
    const res = await second;
    expect(res.status).toBe(429);
    expect(res.headers.get("retry-after")).toBe("1"); // ceil(50/1000)
    expect(transport).toHaveBeenCalledTimes(1); // 超时任务未打上游

    gate.resolve(new Response('{"ok":true}', { status: 200 }));
    await first;
    await new Promise((r) => setTimeout(r, 80)); // 让 drain 收尾（intervalMs=50）
  });

  it("客户端断连：轮到前 abort → 拒绝且不烧上游", async () => {
    const { env } = makeEnv([keyRow("k1")], { maxDepth: 10, intervalMs: 1 });
    const instance = await makeDO(env);
    const gate = deferred<Response>();
    const transport = vi.fn(() => gate.promise);
    vi.stubGlobal("fetch", transport);

    const first = instance.fetch(fakeRequest(taskPayload()));
    await untilPendingEmpty(instance);

    const ac = new AbortController();
    const second = instance.fetch(
      fakeRequest(taskPayload(), { signal: ac.signal })
    );
    ac.abort();

    gate.resolve(new Response('{"ok":true}', { status: 200 }));
    await first;
    await expect(second).rejects.toThrow(
      "client disconnected before its queue slot"
    );
    expect(transport).toHaveBeenCalledTimes(1);
  });

  it("/_internal/sync-keys 装载池；/_internal/activate 清内存冷却；坏 payload→400", async () => {
    const { env } = makeEnv([
      keyRow("k1", {
        cooldown_until: Date.now() + 60_000,
        suspended_cause: "breaker",
      }),
    ]);
    const instance = (await makeDO(env)) as unknown as {
      fetch(req: Request): Promise<Response>;
      pool: {
        pool: {
          getKeys(): Array<{
            id: string;
            cooldown_until: number | null;
            suspended_cause: string | null;
          }>;
        };
      };
    };

    const sync = await instance.fetch(
      fakeRequest({ provider: "tavily" }, { path: "/_internal/sync-keys" })
    );
    expect(await sync.text()).toBe("ok");
    expect(instance.pool.pool.getKeys().map((k) => k.id)).toEqual(["k1"]);
    expect(instance.pool.pool.getKeys()[0]!.cooldown_until).not.toBeNull();

    const act = await instance.fetch(
      fakeRequest(
        { provider: "tavily", id: "k1" },
        { path: "/_internal/activate" }
      )
    );
    expect(await act.text()).toBe("ok");
    expect(instance.pool.pool.getKeys()[0]!.cooldown_until).toBeNull();
    expect(instance.pool.pool.getKeys()[0]!.suspended_cause).toBeNull();

    const bad = await instance.fetch(
      fakeRequest({ provider: "nope" }, { path: "/_internal/sync-keys" })
    );
    expect(bad.status).toBe(400);
  });

  it("drain 快乐路径：200 透传，事件订阅记账 + 收尾 flush/checkpoint 落 D1", async () => {
    const { env, d1 } = makeEnv([keyRow("k1")], {
      maxDepth: 10,
      intervalMs: 1,
    });
    const instance = await makeDO(env);
    const transport = vi.fn(
      async () =>
        new Response('{"ok":true}', {
          status: 200,
          headers: { "content-type": "application/json" },
        })
    );
    vi.stubGlobal("fetch", transport);

    const res = await instance.fetch(fakeRequest(taskPayload()));
    expect(res.status).toBe(200);
    expect(await res.text()).toBe('{"ok":true}');
    expect(transport).toHaveBeenCalledTimes(1);

    // 成功事件 → usage success 记账 + post-use 冷却 dirty；
    // drain 收尾 flushNow → mergeUsage(DB.batch)；pool.maybeCheckpoint → checkpointCooldowns(DB.batch)。
    // item.resolve 在 drain 收尾 flush 之前返回，等一个 intervalMs(1ms)+余量 让收尾落库完成。
    await new Promise((r) => setTimeout(r, 20));
    expect(d1.batchCalls()).toBeGreaterThanOrEqual(2);
  });
});
