// /reader 入口单测：直挂 handleReader（Hono 路由），配 fake QUEUE/DB/KV/caches，
// 断言路由层契约 —— 鉴权 / 协议门禁（reader-only）/ 目标 URL 解析 / 任务打装
// （ReaderTask{kind=reader,url}）转发到队列 DO。
// 不 assert 重试核内部（retry.test.ts 覆盖）：本文件只证明 reader 路由的门禁与打装。

import { describe, it, expect, vi, type Mock } from "vitest";
import { Hono } from "hono";
import { handleReader } from "../src/proxy";
import type { AppVariables, Env } from "../src/types";
import { makeConstantD1 } from "./helpers/fake-d1";

const fakeKV = { get: async () => null, put: async () => {} };

interface QueueCapture {
  stub: { fetch: Mock };
}

function makeQueue(): QueueCapture {
  const stub = {
    fetch: vi.fn(async () => new Response("page text", { status: 200 })),
  };
  return { stub };
}

function buildApp(distRows: Record<string, unknown>[]) {
  const queue = makeQueue();
  const env = {
    DB: makeConstantD1(distRows).db,
    KV: fakeKV,
    QUEUE: {
      idFromName: () => ({}),
      get: () => queue.stub,
    },
    ADMIN_PASSWORD: "x",
    PUBLIC_BASE_URL: "https://proxy.example",
  } as unknown as Env;
  const app = new Hono<{ Bindings: Env; Variables: AppVariables }>();
  app.get("/reader/*", handleReader);
  return { app, env, queue };
}

function callReader(
  app: Hono<{ Bindings: Env; Variables: AppVariables }>,
  env: Env,
  bearer: string,
  path: string
) {
  return app.request(path, { headers: { authorization: `Bearer ${bearer}` } }, env);
}

const enabledRow = (apiKey: string, status: string = "enabled") => ({
  api_key: apiKey,
  note: "test",
  status,
  created_at: Date.now(),
});

describe("GET /reader/*", () => {
  it("reader-tavily 分发 key：任务转发 {kind=reader,url,depth} 到 tavily 队列 DO", async () => {
    const apiKey = "abcd" + "1234";
    const { app, env, queue } = buildApp([enabledRow(apiKey)]);

    const res = await callReader(app, env, `reader-tavily-${apiKey}`, "/reader/https://www.example.com");

    expect(res.status).toBe(200);
    expect(await res.text()).toBe("page text");
    expect(queue.stub.fetch).toHaveBeenCalledTimes(1);
    const init = queue.stub.fetch.mock.calls[0][1] as unknown as RequestInit;
    expect(JSON.parse(String(init.body))).toEqual({
      provider: "tavily",
      apiKey,
      task: { kind: "reader", url: "https://www.example.com", depth: "basic" },
    });
  });

  it("?depth=advanced 透传给任务", async () => {
    const apiKey = "abcd" + "1234";
    const { app, env, queue } = buildApp([enabledRow(apiKey)]);

    const res = await callReader(
      app, env, `reader-tavily-${apiKey}`, "/reader/https://www.example.com?depth=advanced"
    );

    expect(res.status).toBe(200);
    const init = queue.stub.fetch.mock.calls[0][1] as unknown as RequestInit;
    expect(JSON.parse(String(init.body))).toEqual({
      provider: "tavily",
      apiKey,
      task: { kind: "reader", url: "https://www.example.com", depth: "advanced" },
    });
  });

  it("?depth=非法值：400，不转发队列", async () => {
    const apiKey = "abcd" + "1234";
    const { app, env, queue } = buildApp([enabledRow(apiKey)]);

    const res = await callReader(
      app, env, `reader-tavily-${apiKey}`, "/reader/https://www.example.com?depth=deep"
    );

    expect(res.status).toBe(400);
    expect(queue.stub.fetch).not.toHaveBeenCalled();
  });

  it("缺目标 URL：400，不转发队列、不计调用", async () => {
    const apiKey = "abcd" + "1234";
    const { app, env, queue } = buildApp([enabledRow(apiKey)]);

    const res = await callReader(app, env, `reader-tavily-${apiKey}`, "/reader/");

    expect(res.status).toBe(400);
    expect(queue.stub.fetch).not.toHaveBeenCalled();
  });

  it("native 前缀（tavily-<key>）打 /reader：405，不转发队列", async () => {
    const apiKey = "abcd" + "1234";
    const { app, env, queue } = buildApp([enabledRow(apiKey)]);

    const res = await callReader(app, env, `tavily-${apiKey}`, "/reader/https://www.example.com");

    expect(res.status).toBe(405);
    expect(queue.stub.fetch).not.toHaveBeenCalled();
  });

  it("searxng 前缀（searxng-tavily-<key>）打 /reader：405，不转发队列", async () => {
    const apiKey = "abcd" + "1234";
    const { app, env, queue } = buildApp([enabledRow(apiKey)]);

    const res = await callReader(app, env, `searxng-tavily-${apiKey}`, "/reader/https://www.example.com");

    expect(res.status).toBe(405);
    expect(queue.stub.fetch).not.toHaveBeenCalled();
  });

  it("exa 前缀（exa-<key>）打 /reader：405（非 reader 协议），不转发队列", async () => {
    const apiKey = "abcd" + "1234";
    const { app, env, queue } = buildApp([enabledRow(apiKey)]);

    const res = await callReader(app, env, `exa-${apiKey}`, "/reader/https://www.example.com");

    expect(res.status).toBe(405);
    expect(queue.stub.fetch).not.toHaveBeenCalled();
  });

  it("分发 key 已禁用：401，不转发队列", async () => {
    const apiKey = "abcd" + "1234";
    const { app, env, queue } = buildApp([enabledRow(apiKey, "disabled")]);

    const res = await callReader(app, env, `reader-tavily-${apiKey}`, "/reader/https://www.example.com");

    expect(res.status).toBe(401);
    expect(queue.stub.fetch).not.toHaveBeenCalled();
  });

  it("未知分发 key：401，不转发队列", async () => {
    const { app, env, queue } = buildApp([]);

    const res = await callReader(app, env, "reader-tavily-0000unknown", "/reader/https://www.example.com");

    expect(res.status).toBe(401);
    expect(queue.stub.fetch).not.toHaveBeenCalled();
  });
});
