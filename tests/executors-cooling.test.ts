// 三个执行器的全冷却渲染单测：key 池全部处于冷却且等待预算为 0 时，
// native / searxng / reader 的 onFailure 都应渲染 429 + Retry-After（而非 503），
// 且绝不触达上游 transport。FSM 侧行为（cooling outcome、sleep 预算）由
// tests/retry.test.ts 覆盖；本文件只锁定"执行器 → 协议响应"这一段。

import { describe, it, expect, vi, type Mock } from "vitest";
import type { Env } from "../src/types";
import { TAVILY } from "../src/providers";
import type { CoreKey } from "../src/domain";
import { createUsageStore } from "../src/usage";
import { createKeyPool } from "../src/key-pool";
import type { CoreDeps } from "../src/domain-services/retry-state-machine";
import { runNativeTask } from "../src/proxy/executors/native";
import { runSearxngTask } from "../src/proxy/executors/searxng";
import { runReaderTask } from "../src/proxy/executors/reader";
import { makeConstantD1 } from "./helpers/fake-d1";

const fakeKV = { get: async () => null, put: async () => {} };

/** 单把冷却 60s 的 key；transport 断言 0 调用；预算 0 → 立即 cooling-out。 */
function coolingDeps(): { deps: CoreDeps; transport: Mock } {
  const rows: Record<string, unknown>[] = [
    {
      id: "k-cool",
      key: "tvly-k-cool",
      name: "",
      status: "enabled",
      cooldown_until: Date.now() + 60_000,
      suspended_cause: "post-use",
      created_at: Date.now(),
    },
  ];
  const env = { DB: makeConstantD1(rows).db, KV: fakeKV } as unknown as Env;
  const transport = vi.fn();
  const deps: CoreDeps = {
    env,
    executionCtx: { waitUntil: () => {} },
    pool: createKeyPool(env, TAVILY.upstream, rows as CoreKey[]),
    events: { publish: () => {} },
    transport: transport as unknown as CoreDeps["transport"],
    usage: createUsageStore(env),
    coolingWaitBudgetMs: 0,
    sleep: async () => {},
  };
  return { deps, transport };
}

async function expectCooling429(res: Response, messagePart: string): Promise<void> {
  expect(res.status).toBe(429);
  expect(res.headers.get("retry-after")).toBe("60");
  const body = (await res.json()) as { error?: string; detail?: { error?: string } };
  const text = body.error ?? body.detail?.error ?? "";
  expect(text).toContain(messagePart);
}

describe("执行器：全冷却 → 429 + Retry-After", () => {
  it("native：Tavily 错误体 + retry-after 60，transport 0 次", async () => {
    const { deps, transport } = coolingDeps();
    const res = await runNativeTask(deps, TAVILY, "api", {
      kind: "native",
      path: TAVILY.capabilities.search.path,
      body: "{}",
      contentType: "application/json",
    });
    await expectCooling429(res, "cooling down");
    expect(transport).not.toHaveBeenCalled();
  });

  it("searxng：error 体 + retry-after 60，transport 0 次", async () => {
    const { deps, transport } = coolingDeps();
    const res = await runSearxngTask(deps, TAVILY, "api", {
      kind: "searxng",
      query: "q",
      body: "{}",
      contentType: "application/json",
    });
    await expectCooling429(res, "cooling down");
    expect(transport).not.toHaveBeenCalled();
  });

  it("reader：error 体 + retry-after 60，transport 0 次", async () => {
    const { deps, transport } = coolingDeps();
    const res = await runReaderTask(deps, TAVILY, "api", {
      kind: "reader",
      url: "https://example.com",
      depth: "basic",
    });
    await expectCooling429(res, "cooling down");
    expect(transport).not.toHaveBeenCalled();
  });
});
