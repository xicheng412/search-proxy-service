// countDist 中间件单测：dist 统计改为主 Worker 记「请求到达量」。
// 直挂真实 proxyApp + fake D1/KV/QUEUE，断言每笔通过 authenticate 鉴权的数据面请求
// 在转发前恰 +1（countDist，主 Worker 同 isolate pending 即时可见）；401（禁用/未知 key）
// 在 authenticate 短路、不达 countDist → 不计数。
// getUsageStore 是 per-isolate 单例：每用例用唯一分发 key（cnt-*），空 D1 rows，避免串扰。
// 另：flushSoon 首次 record 会立即落库清空 pending（lastFlushAt 从 0 起），故在 beforeAll
// 先触发一次 flush 推进节流时钟，保证用例请求只进 pending、可被 readDistCallsByScopes 叠加读。

import { describe, it, expect, beforeAll, vi, type Mock } from "vitest";
import type { Hono } from "hono";
import type { ExecutionContext } from "@cloudflare/workers-types";
import { proxyApp } from "../src/routes/proxy";
import type { AppVariables, Env } from "../src/types";
import { getUsageStore } from "../src/usage";
import { hourKey } from "../src/domain";
import { makeConstantD1 } from "./helpers/fake-d1";

const fakeKV = { get: async () => null, put: async () => {} };

function makeQueue() {
  return {
    fetch: vi.fn(async () => {
      return new Response('{"results":[],"failed_results":[]}', {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    }),
  };
}

function makeEnv(queue: { fetch: Mock }, distRows: Record<string, unknown>[]) {
  return {
    DB: makeConstantD1(distRows).db,
    KV: fakeKV,
    QUEUE: {
      idFromName: () => ({}),
      get: () => queue,
    },
    ADMIN_PASSWORD: "x",
    PUBLIC_BASE_URL: "https://proxy.example",
  } as unknown as Env;
}

// 推进共享 per-isolate store 的 flush 时钟（防首次 record 立即落库清空 pending）。
beforeAll(async () => {
  const store = getUsageStore(makeEnv(makeQueue(), []));
  let captured: Promise<unknown> | undefined;
  store.recordDistCall("__prime__", hourKey());
  store.flushSoon({ waitUntil: (p) => (captured = p) } as never);
  expect(captured).toBeDefined();
  await captured;
});

const enabledRow = (apiKey: string, status: string = "enabled") => ({
  api_key: apiKey,
  note: "test",
  status,
  created_at: Date.now(),
});

function buildFor(apiKey: string, rows: Record<string, unknown>[]) {
  const queue = makeQueue();
  const env = makeEnv(queue, rows);
  // proxyApp 已内建 cors + authenticate + countDist + handler
  return { app: proxyApp, env, queue };
}

function postExtract(
  app: Hono<{ Bindings: Env; Variables: AppVariables }>,
  env: Env,
  bearer: string
) {
  return app.request(
    "/extract",
    {
      method: "POST",
      headers: {
        authorization: `Bearer ${bearer}`,
        "content-type": "application/json",
      },
      body: '{"urls":"https://example.com"}',
    },
    env,
    { waitUntil: () => {} } as unknown as ExecutionContext
  );
}

describe("countDist 请求到达计数", () => {
  it("鉴权通过的请求：主 Worker 记 +1（success=1/fail=0）", async () => {
    const apiKey = "cnt1";
    const { app, env } = buildFor(apiKey, [enabledRow(apiKey)]);
    const h = hourKey();

    const res = await postExtract(app, env, `tavily-${apiKey}`);

    expect(res.status).toBe(200);
    const stats = await getUsageStore(env).readDistCallsByScopes([apiKey], h);
    expect(stats[apiKey]).toEqual({ success: 1, fail: 0 });
  });

  it("同 key 两次请求：恰 +2（每请求一次）", async () => {
    const apiKey = "cnt2";
    const { app, env } = buildFor(apiKey, [enabledRow(apiKey)]);
    const h = hourKey();

    await postExtract(app, env, `tavily-${apiKey}`);
    await postExtract(app, env, `tavily-${apiKey}`);

    const stats = await getUsageStore(env).readDistCallsByScopes([apiKey], h);
    expect(stats[apiKey]).toEqual({ success: 2, fail: 0 });
  });

  it("禁用分发 key：401 短路，不计数（0/0）", async () => {
    const apiKey = "cnt3";
    const { app, env } = buildFor(apiKey, [enabledRow(apiKey, "disabled")]);
    const h = hourKey();

    const res = await postExtract(app, env, `tavily-${apiKey}`);

    expect(res.status).toBe(401);
    const stats = await getUsageStore(env).readDistCallsByScopes([apiKey], h);
    expect(stats[apiKey]).toEqual({ success: 0, fail: 0 });
  });

  it("未知分发 key：401 短路，不计数（0/0）", async () => {
    const apiKey = "cnt4";
    const { app, env } = buildFor(apiKey, []);
    const h = hourKey();

    const res = await postExtract(app, env, `tavily-${apiKey}`);

    expect(res.status).toBe(401);
    const stats = await getUsageStore(env).readDistCallsByScopes([apiKey], h);
    expect(stats[apiKey]).toEqual({ success: 0, fail: 0 });
  });
});
