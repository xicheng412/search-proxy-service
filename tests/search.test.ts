// /search 入口单测：直挂真实 proxyApp + fake D1/KV/QUEUE，
// 断言 native(tavily/exa) 打装、reader 前缀 405、searxng GET/POST 打装、
// pageno>1 空结果短路（不转发队列）。dist 计数断言见 count-dist.test.ts。

import { describe, it, expect, vi } from "vitest";
import type { ExecutionContext } from "@cloudflare/workers-types";
import { proxyApp } from "../src/routes/proxy";
import type { Env } from "../src/types";
import { makeConstantD1 } from "./helpers/fake-d1";

const fakeKV = { get: async () => null, put: async () => {} };

function buildApp(distRows: Record<string, unknown>[] = []) {
  const stub = {
    fetch: vi.fn(
      async () =>
        new Response('{"results":[]}', {
          status: 200,
          headers: { "content-type": "application/json" },
        })
    ),
  };
  const env = {
    DB: makeConstantD1(distRows).db,
    KV: fakeKV,
    QUEUE: { idFromName: () => ({}), get: () => stub },
    ADMIN_PASSWORD: "x",
    PUBLIC_BASE_URL: "https://proxy.example",
  } as unknown as Env;
  return { app: proxyApp, env, stub };
}

const enabledRow = (apiKey: string) => ({
  api_key: apiKey,
  note: "test",
  status: "enabled",
  created_at: 1,
});

function call(
  app: typeof proxyApp,
  env: Env,
  path: string,
  init: RequestInit
) {
  return app.request(path, init, env, {
    waitUntil: () => {},
  } as unknown as ExecutionContext);
}

describe("POST /search native", () => {
  it("tavily 前缀：打装 NativeTask path=/search，透传 body/contentType", async () => {
    const apiKey = "srch1";
    const { app, env, stub } = buildApp([enabledRow(apiKey)]);

    const res = await call(app, env, "/search", {
      method: "POST",
      headers: {
        authorization: `Bearer tavily-${apiKey}`,
        "content-type": "application/json",
      },
      body: '{"query":"x"}',
    });

    expect(res.status).toBe(200);
    const init = stub.fetch.mock.calls[0][1] as RequestInit;
    expect(JSON.parse(String(init.body))).toEqual({
      provider: "tavily",
      apiKey,
      task: {
        kind: "native",
        path: "/search",
        body: '{"query":"x"}',
        contentType: "application/json",
      },
    });
  });

  it("exa 前缀：native Search 合法（provider=exa，path=/search）", async () => {
    const apiKey = "srch2";
    const { app, env, stub } = buildApp([enabledRow(apiKey)]);

    const res = await call(app, env, "/search", {
      method: "POST",
      headers: {
        authorization: `Bearer exa-${apiKey}`,
        "content-type": "application/json",
      },
      body: '{"query":"x"}',
    });

    expect(res.status).toBe(200);
    const init = stub.fetch.mock.calls[0][1] as RequestInit;
    expect(JSON.parse(String(init.body))).toEqual({
      provider: "exa",
      apiKey,
      task: {
        kind: "native",
        path: "/search",
        body: '{"query":"x"}',
        contentType: "application/json",
      },
    });
  });

  it("reader-tavily 前缀：405，不转发队列", async () => {
    const apiKey = "srch3";
    const { app, env, stub } = buildApp([enabledRow(apiKey)]);

    const res = await call(app, env, "/search", {
      method: "POST",
      headers: {
        authorization: `Bearer reader-tavily-${apiKey}`,
        "content-type": "application/json",
      },
      body: "{}",
    });

    expect(res.status).toBe(405);
    expect(stub.fetch).not.toHaveBeenCalled();
  });
});

describe("searxng /search", () => {
  it("GET 成功：打成 SearxngTask（topic 省略）", async () => {
    const apiKey = "srch4";
    const { app, env, stub } = buildApp([enabledRow(apiKey)]);

    const res = await call(app, env, "/search?q=hello", {
      method: "GET",
      headers: { authorization: `Bearer searxng-tavily-${apiKey}` },
    });

    expect(res.status).toBe(200);
    const init = stub.fetch.mock.calls[0][1] as RequestInit;
    expect(JSON.parse(String(init.body))).toEqual({
      provider: "tavily",
      apiKey,
      task: {
        kind: "searxng",
        query: "hello",
        body: '{"query":"hello","max_results":10}',
        contentType: "application/json",
      },
    });
  });

  it("POST 表单成功：打成 SearxngTask", async () => {
    const apiKey = "srch5";
    const { app, env, stub } = buildApp([enabledRow(apiKey)]);

    const res = await call(app, env, "/search", {
      method: "POST",
      headers: {
        authorization: `Bearer searxng-tavily-${apiKey}`,
        "content-type": "application/x-www-form-urlencoded",
      },
      body: "q=hello",
    });

    expect(res.status).toBe(200);
    const init = stub.fetch.mock.calls[0][1] as RequestInit;
    expect(JSON.parse(String(init.body))).toEqual({
      provider: "tavily",
      apiKey,
      task: {
        kind: "searxng",
        query: "hello",
        body: '{"query":"hello","max_results":10}',
        contentType: "application/json",
      },
    });
  });

  it("pageno>1：200 空结果短路，不转发队列", async () => {
    const apiKey = "srch6";
    const { app, env, stub } = buildApp([enabledRow(apiKey)]);

    const res = await call(app, env, "/search?q=hello&pageno=2", {
      method: "GET",
      headers: { authorization: `Bearer searxng-tavily-${apiKey}` },
    });

    expect(res.status).toBe(200);
    const body = (await res.json()) as Record<string, unknown>;
    expect(body["query"]).toBe("hello");
    expect(body["results"]).toEqual([]);
    expect(stub.fetch).not.toHaveBeenCalled();
  });

  it("非法 format：400，不转发队列", async () => {
    const apiKey = "srch7";
    const { app, env, stub } = buildApp([enabledRow(apiKey)]);

    const res = await call(app, env, "/search?q=hello&format=xml", {
      method: "GET",
      headers: { authorization: `Bearer searxng-tavily-${apiKey}` },
    });

    expect(res.status).toBe(400);
    expect(stub.fetch).not.toHaveBeenCalled();
  });
});
