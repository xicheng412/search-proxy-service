// retry 重试矩阵单测：直接调用 searchWithRetry（src/retry.ts），配 fake D1(+fake KV) 环境，
// 断言 callback 入参（onFailure 的 outcome.kind / lastRes.status）与 fetch 次数/去重 key。
// 不 assert 内部实现：熔断写入细节由 tests/breaker.test.ts 覆盖；选 key 权重/统计不在本矩阵。

import { describe, it, expect, vi, afterEach, type Mock } from "vitest";
import type { Env } from "../src/types";
import { TAVILY } from "../src/providers";
import type { CoreKey } from "../src/domain";
import type { UsageStore } from "../src/usage-store";
import {
  searchWithRetry,
  TRANSITIONS,
  emit,
  type CoreDeps,
  type RetryContext,
  type RetryState,
} from "../src/retry";
import { makeConstantD1 } from "./helpers/fake-d1";

const fakeKV = { get: async () => null, put: async () => {} };

function makeEnv(rows: Record<string, unknown>[]) {
  return { DB: makeConstantD1(rows).db, KV: fakeKV } as unknown as Env;
}

function makeDeps(rows: Record<string, unknown>[]): CoreDeps {
  return { env: makeEnv(rows), executionCtx: { waitUntil: () => {} } };
}

function keyRow(id: string, overrides: Record<string, unknown> = {}) {
  return {
    id,
    key: "tvly-" + id,
    name: "",
    status: "enabled",
    cooldown_until: null,
    created_at: Date.now(),
    ...overrides,
  };
}

/** 按序消费状态码的 fetch mock；队列耗尽后重复最后一个状态码。 */
function fetchMockWith(...statuses: number[]) {
  const queue = [...statuses];
  const last = queue.length > 0 ? queue[queue.length - 1] : 200;
  return vi.fn(async (_input: unknown, init?: RequestInit) => {
    const status = queue.length > 0 ? queue.shift()! : last;
    return new Response('{"ok":true}', {
      status,
      headers: { "content-type": "application/json" },
    });
  });
}

/** 每次 fetch 携带的 Authorization（Bearer <上游key>）去重集合。 */
function bearerSet(mock: Mock): Set<string> {
  const out = new Set<string>();
  for (const c of mock.mock.calls) {
    const init = c[1] as unknown as { headers?: Record<string, unknown> } | undefined;
    out.add(String(init?.headers?.["authorization"]));
  }
  return out;
}

const req = { path: TAVILY.capabilities.search.path, body: "{}", contentType: "application/json" };

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("searchWithRetry 重试矩阵", () => {
  it("1. 2xx 成功：1 key，onSuccess 产物直接返回，onFailure 不调", async () => {
    const fetchMock = fetchMockWith(200);
    vi.stubGlobal("fetch", fetchMock);
    const onSuccess = vi.fn(async () => new Response("ok"));
    const onFailure = vi.fn(async () => new Response("fail", { status: 502 }));

    const res = await searchWithRetry(
      makeDeps([keyRow("k-t1-a")]),
      TAVILY,
      "api-t1",
      req,
      { onSuccess, onFailure }
    );

    expect(onFailure).not.toHaveBeenCalled();
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(await res.text()).toBe("ok");
  });

  it("2. 2xx 但 onSuccess→null（响应不可用）：换 key 试遍 2 把 → exhausted(lastRes 200)", async () => {
    const fetchMock = fetchMockWith(200, 200);
    vi.stubGlobal("fetch", fetchMock);
    const onSuccess = vi.fn(async () => null);
    const onFailure = vi.fn(async () => new Response("fail", { status: 502 }));

    await searchWithRetry(
      makeDeps([keyRow("k-t2-a"), keyRow("k-t2-b")]),
      TAVILY,
      "api-t2",
      req,
      { onSuccess, onFailure }
    );

    expect(onFailure).toHaveBeenCalledTimes(1);
    expect(onFailure.mock.calls[0][0]).toMatchObject({ kind: "exhausted" });
    expect(onFailure.mock.calls[0][0].lastRes?.status).toBe(200);
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(bearerSet(fetchMock).size).toBe(2); // 两次尝试不同 key
  });

  it("3. 429 一直换遍 2 keys → exhausted（429 不客户端终止）", async () => {
    const fetchMock = fetchMockWith(429, 429);
    vi.stubGlobal("fetch", fetchMock);
    const onSuccess = vi.fn(async () => new Response("ok"));
    const onFailure = vi.fn(async () => new Response("fail", { status: 502 }));

    await searchWithRetry(
      makeDeps([keyRow("k-t3-a"), keyRow("k-t3-b")]),
      TAVILY,
      "api-t3",
      req,
      { onSuccess, onFailure }
    );

    expect(onFailure).toHaveBeenCalledTimes(1);
    expect(onFailure.mock.calls[0][0]).toMatchObject({ kind: "exhausted" });
    expect(onFailure.mock.calls[0][0].lastRes?.status).toBe(429);
    expect(onSuccess).not.toHaveBeenCalled();
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(bearerSet(fetchMock).size).toBe(2);
  });

  it("3b. 432 (Tavily key/plan limit) 类 429：换 key 重试，不客户端终止、不记失败熔断", async () => {
    // 432 是配额条件而非 key 故障：按限流处理（换 key 试一把、仅 post-use 冷却），
    // 而非 server-error 的"记败 + 指数退避冷却"——否则打爆 plan 会把共用 key 误伤冷却。
    const fetchMock = fetchMockWith(432, 432);
    vi.stubGlobal("fetch", fetchMock);
    const onSuccess = vi.fn(async () => new Response("ok"));
    const onFailure = vi.fn(async () => new Response("fail", { status: 502 }));

    await searchWithRetry(
      makeDeps([keyRow("k-t3b-a"), keyRow("k-t3b-b")]),
      TAVILY,
      "api-t3b",
      req,
      { onSuccess, onFailure }
    );

    expect(onFailure).toHaveBeenCalledTimes(1);
    expect(onFailure.mock.calls[0][0]).toMatchObject({ kind: "exhausted" });
    expect(onFailure.mock.calls[0][0].lastRes?.status).toBe(432);
    expect(onSuccess).not.toHaveBeenCalled();
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(bearerSet(fetchMock).size).toBe(2);
  });

  it.each([400, 404, 422, 433])(
    "4. %s → 立即 client-error，不重试、不换 key",
    async (status) => {
      const fetchMock = fetchMockWith(status);
      vi.stubGlobal("fetch", fetchMock);
      const onSuccess = vi.fn(async () => new Response("ok"));
      const onFailure = vi.fn(async () => new Response("fail", { status: 502 }));

      await searchWithRetry(
        makeDeps([keyRow("k-t4a-" + status)]),
        TAVILY,
        "api-t4-" + status,
        req,
        { onSuccess, onFailure }
      );

      expect(onFailure).toHaveBeenCalledTimes(1);
      expect(onFailure.mock.calls[0][0]).toMatchObject({ kind: "client-error" });
      expect(onFailure.mock.calls[0][0].lastRes?.status).toBe(status);
      expect(fetchMock).toHaveBeenCalledTimes(1);
    }
  );

  it("5. 401 → 换 key（key 级错误，非 client-error），试遍 2 把 → exhausted", async () => {
    const fetchMock = fetchMockWith(401, 401);
    vi.stubGlobal("fetch", fetchMock);
    const onSuccess = vi.fn(async () => new Response("ok"));
    const onFailure = vi.fn(async () => new Response("fail", { status: 502 }));

    await searchWithRetry(
      makeDeps([keyRow("k-t5-a"), keyRow("k-t5-b")]),
      TAVILY,
      "api-t5",
      req,
      { onSuccess, onFailure }
    );

    expect(onFailure).toHaveBeenCalledTimes(1);
    expect(onFailure.mock.calls[0][0]).toMatchObject({ kind: "exhausted" });
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(bearerSet(fetchMock).size).toBe(2);
  });

  it("6. 无 key → no-keys，0 次 fetch", async () => {
    const fetchMock = fetchMockWith();
    vi.stubGlobal("fetch", fetchMock);
    const onSuccess = vi.fn(async () => new Response("ok"));
    const onFailure = vi.fn(async () => new Response("fail", { status: 502 }));

    await searchWithRetry(makeDeps([]), TAVILY, "api-t6", req, {
      onSuccess,
      onFailure,
    });

    expect(onFailure).toHaveBeenCalledTimes(1);
    expect(onFailure.mock.calls[0][0]).toMatchObject({ kind: "no-keys" });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("7. 全部冷却 → unavailable，0 次 fetch", async () => {
    const fetchMock = fetchMockWith();
    vi.stubGlobal("fetch", fetchMock);
    const onSuccess = vi.fn(async () => new Response("ok"));
    const onFailure = vi.fn(async () => new Response("fail", { status: 502 }));

    await searchWithRetry(
      makeDeps([
        keyRow("k-t7-a", { cooldown_until: Date.now() + 60_000 }),
        keyRow("k-t7-b", { cooldown_until: Date.now() + 60_000 }),
      ]),
      TAVILY,
      "api-t7",
      req,
      { onSuccess, onFailure }
    );

    expect(onFailure).toHaveBeenCalledTimes(1);
    expect(onFailure.mock.calls[0][0]).toMatchObject({ kind: "unavailable" });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("8. 4 keys、全 500 → 截在 MAX_ATTEMPTS=3 次，不碰第 4 把", async () => {
    const fetchMock = fetchMockWith(500, 500, 500, 500);
    vi.stubGlobal("fetch", fetchMock);
    const onSuccess = vi.fn(async () => new Response("ok"));
    const onFailure = vi.fn(async () => new Response("fail", { status: 502 }));

    await searchWithRetry(
      makeDeps([keyRow("k-t8-a"), keyRow("k-t8-b"), keyRow("k-t8-c"), keyRow("k-t8-d")]),
      TAVILY,
      "api-t8",
      req,
      { onSuccess, onFailure }
    );

    expect(onFailure.mock.calls[0][0]).toMatchObject({ kind: "exhausted" });
    expect(fetchMock).toHaveBeenCalledTimes(3);
    expect(bearerSet(fetchMock).size).toBe(3);
  });

  it("9. 429 后换 key 成功：第 1 次 429、第 2 次 200 → onSuccess 产物", async () => {
    const fetchMock = fetchMockWith(429, 200);
    vi.stubGlobal("fetch", fetchMock);
    const onSuccess = vi.fn(async () => new Response("ok"));
    const onFailure = vi.fn(async () => new Response("fail", { status: 502 }));

    const res = await searchWithRetry(
      makeDeps([keyRow("k-t9-a"), keyRow("k-t9-b")]),
      TAVILY,
      "api-t9",
      req,
      { onSuccess, onFailure }
    );

    expect(onFailure).not.toHaveBeenCalled();
    expect(onSuccess).toHaveBeenCalledTimes(1);
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(bearerSet(fetchMock).size).toBe(2); // 两次尝试不同 key
    expect(await res.text()).toBe("ok");
  });
});

// ---- 重试状态机（FSM）单测：零 fetch，直测迁移表与 emit（src/retry.ts 的 test-only 导出）----

/**
 * 构造 emit("pick") 最小上下文：非 pick 读取路径不触 env/store/cb，用惰性 stub。
 * 每次调用返回全新实例（tried 默认空 Set），避免测试间串状态。
 */
function pickCtx(
  keys: CoreKey[],
  attempt = 0,
  tried = new Set<string>()
): RetryContext {
  return {
    env: makeEnv([]),
    def: TAVILY,
    request: req,
    // 仅 emit("pick")：该路径不触 store/cb，stub 即可
    cb: {
      onSuccess: async () => null,
      onFailure: async () => new Response("fail", { status: 502 }),
    },
    store: {} as UsageStore,
    hour: "",
    keys,
    statsMap: {},
    tried,
    lastRes: null,
    attempt,
    currentKey: null,
  };
}

describe("重试状态机（FSM）", () => {
  /** 迁移表 12 行逐行断言；第三列 = 是否应携带副作用 action。 */
  const table: Array<[key: string, to: RetryState, hasAction: boolean]> = [
    ["init:no-keys", "no-keys", false],
    ["init:empty-candidates", "unavailable", false],
    ["init:ready", "pick", false],
    ["pick:picked", "in-flight", false],
    ["pick:depleted", "exhausted", false],
    ["in-flight:success", "success", true],
    ["in-flight:unusable", "pick", true],
    ["in-flight:network", "pick", true],
    ["in-flight:rate-limit", "pick", true],
    ["in-flight:client-error", "client-error", false],
    ["in-flight:auth-error", "pick", true],
    ["in-flight:server-error", "pick", true],
  ];

  it("迁移表：12 行键齐全（缺配/多配即失败）、to 正确、action 有无与副作用表一致", () => {
    // 守卫：未来新增事件或漏配迁移，键集合变差即失败
    expect(Object.keys(TRANSITIONS).sort()).toEqual(table.map(([k]) => k).sort());

    for (const [key, to, hasAction] of table) {
      expect(TRANSITIONS[key].to).toBe(to);
      if (hasAction) {
        expect(TRANSITIONS[key].action).toBeDefined();
      } else {
        expect(TRANSITIONS[key].action).toBeUndefined();
      }
    }
  });

  it('emit("pick") 达到 MAX_ATTEMPTS 上限 → depleted，不再选 key', async () => {
    const ctx = pickCtx([keyRow("k-g1")], 3 /* = MAX_ATTEMPTS */);
    const ev = await emit("pick", ctx);
    expect(ev).toEqual({ kind: "depleted" });
    expect(ctx.attempt).toBe(3);
    expect(ctx.currentKey).toBeNull();
  });

  it('emit("pick") 首个可用候选 → picked 并推进 attempt/tried/currentKey', async () => {
    const ctx = pickCtx([keyRow("k-g1")]);
    const ev = await emit("pick", ctx);
    expect(ev).toMatchObject({ kind: "picked", key: { id: "k-g1" } });
    expect(ctx.attempt).toBe(1);
    expect(ctx.tried.size).toBe(1);
    expect(ctx.tried.has("k-g1")).toBe(true);
    expect(ctx.currentKey?.id).toBe("k-g1");
  });

  it('emit("pick") 候选已全部尝试（tried 占满）→ depleted', async () => {
    const ctx = pickCtx([keyRow("k-g1")], 0, new Set(["k-g1"]));
    const ev = await emit("pick", ctx);
    expect(ev).toEqual({ kind: "depleted" });
    expect(ctx.attempt).toBe(0);
  });
});
