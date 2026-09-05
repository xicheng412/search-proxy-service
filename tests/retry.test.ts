// retry 重试矩阵单测：直接调用 searchWithRetry（src/retry.ts），配 fake D1(+fake KV) 环境，
// 断言 callback 入参（onFailure 的 outcome.kind / lastRes.status）与 fetch 次数/去重 key。
// 不 assert 内部实现：熔断写入细节由 tests/breaker.test.ts 覆盖；选 key 权重/统计不在本矩阵。

import { describe, it, expect, vi, afterEach, type Mock } from "vitest";
import type { Env } from "../src/types";
import { TAVILY } from "../src/providers";
import { searchWithRetry, type CoreDeps } from "../src/retry";
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

const req = { path: TAVILY.endpoints.search, body: "{}", contentType: "application/json" };

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

  it.each([400, 404, 422])(
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
