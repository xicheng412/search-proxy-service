// /extract 入口单测：直挂 handleExtract（Hono 路由），配 fake QUEUE/DB/KV/caches，
// 断言路由层契约 —— 鉴权 / 协议门禁（native-only）/ provider 门禁（仅 tavily）/ 任务打装
// （path=/extract + body/contentType 透传）转发到队列 DO。
// 不 assert 重试核内部（retry.test.ts 覆盖）：本文件只证明"统计链路的前置门禁不误记、
// 命中 extract 的任务确实带对 path 进队列"，这是 /extract 各维度统计正确的起点。

import { describe, it, expect, vi, type Mock } from "vitest";
import { Hono } from "hono";
import { handleExtract } from "../src/proxy";
import type { AppVariables, Env } from "../src/types";
import { makeConstantD1 } from "./helpers/fake-d1";

const fakeKV = { get: async () => null, put: async () => {} };

interface QueueCapture {
  stub: { fetch: Mock };
}

function makeQueue(): QueueCapture {
  const stub = {
    fetch: vi.fn(async () => {
      return new Response('{"results":[],"failed_results":[]}', {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    }),
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
  app.post("/extract", handleExtract);
  return { app, env, queue };
}

function callExtract(
  app: Hono<{ Bindings: Env; Variables: AppVariables }>,
  env: Env,
  bearer: string,
  body = '{"urls":"https://example.com"}'
) {
  return app.request(
    "/extract",
    {
      method: "POST",
      headers: {
        authorization: `Bearer ${bearer}`,
        "content-type": "application/json",
      },
      body,
    },
    env
  );
}

const enabledRow = (apiKey: string, status: string = "enabled") => ({
  api_key: apiKey,
  note: "test",
  status,
  created_at: Date.now(),
});

describe("POST /extract", () => {
  it("tavily native 分发 key：任务转发 path=/extract，body/contentType 原样透传，走队列 DO", async () => {
    const apiKey = "abcd" + "1234";
    const { app, env, queue } = buildApp([enabledRow(apiKey)]);
    const body = '{"urls":["https://a.com","https://b.com"],"extract_depth":"advanced"}';

    const res = await callExtract(app, env, `tavily-${apiKey}`, body);

    expect(res.status).toBe(200);
    expect(queue.stub.fetch).toHaveBeenCalledTimes(1);
    const init = queue.stub.fetch.mock.calls[0][1] as unknown as RequestInit;
    expect(JSON.parse(String(init.body))).toEqual({
      provider: "tavily",
      apiKey,
      task: {
        kind: "native",
        path: "/extract",
        body,
        contentType: "application/json",
      },
    });
  });

  it("searxng 前缀（searxng-tavily-<key>）：405，不转发队列、不计调用", async () => {
    const apiKey = "abcd" + "1234";
    const { app, env, queue } = buildApp([enabledRow(apiKey)]);

    const res = await callExtract(app, env, `searxng-tavily-${apiKey}`);

    expect(res.status).toBe(405);
    expect(queue.stub.fetch).not.toHaveBeenCalled();
  });

  it("exa 分发 key（无 extract 端点）：404，不转发队列、不计调用", async () => {
    const apiKey = "abcd" + "1234";
    const { app, env, queue } = buildApp([enabledRow(apiKey)]);

    const res = await callExtract(app, env, `exa-${apiKey}`);

    expect(res.status).toBe(404);
    expect(queue.stub.fetch).not.toHaveBeenCalled();
  });

  it("分发 key 已禁用：401，不转发队列", async () => {
    const apiKey = "abcd" + "1234";
    const { app, env, queue } = buildApp([enabledRow(apiKey, "disabled")]);

    const res = await callExtract(app, env, `tavily-${apiKey}`);

    expect(res.status).toBe(401);
    expect(queue.stub.fetch).not.toHaveBeenCalled();
  });

  it("未知分发 key：401，不转发队列", async () => {
    const { app, env, queue } = buildApp([]);

    const res = await callExtract(app, env, "tavily-0000unknown");

    expect(res.status).toBe(401);
    expect(queue.stub.fetch).not.toHaveBeenCalled();
  });
});
