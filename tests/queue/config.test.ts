// 队列参数契约：readQueueConfig 的缺省回退 / 合法透传 / 损坏回退验证。
// 使用内联最小 KV fake（get 返回预置 raw，put 恒 no-op），不连接真实 KV。
// KVNamespace 是 workers-types 全局类型（tests 不在 tsc include 内），仅作标注形参。

import { describe, it, expect } from "vitest";
import { DEFAULT_QUEUE_CONFIG, readQueueConfig } from "../../src/queue/config";
import type { KVNamespace } from "@cloudflare/workers-types";

function fakeKv(raw: unknown): KVNamespace {
  return {
    get: async (_key: string, _type?: string) => raw,
    put: async () => {},
  } as unknown as KVNamespace;
}

describe("readQueueConfig", () => {
  it("空 KV 回退缺省（含 waitBudgetMs 30000）", async () => {
    const cfg = await readQueueConfig(fakeKv(null));
    expect(cfg).toEqual(DEFAULT_QUEUE_CONFIG);
    expect(cfg.waitBudgetMs).toBe(30000);
  });

  it("合法 KV 全字段取整透传", async () => {
    const cfg = await readQueueConfig(
      fakeKv({ intervalMs: 5000.4, maxDepth: 20.7, waitBudgetMs: 45000.6 })
    );
    expect(cfg).toEqual({ intervalMs: 5000, maxDepth: 20, waitBudgetMs: 45001 });
  });

  it("waitBudgetMs 为字符串 → 该项回退默认值", async () => {
    const cfg = await readQueueConfig(
      fakeKv({ intervalMs: 5000, maxDepth: 20, waitBudgetMs: "abc" })
    );
    expect(cfg).toEqual({ intervalMs: 5000, maxDepth: 20, waitBudgetMs: 30000 });
  });

  it("waitBudgetMs 为负数 → 该项回退默认值", async () => {
    const cfg = await readQueueConfig(
      fakeKv({ intervalMs: 5000, maxDepth: 20, waitBudgetMs: -1 })
    );
    expect(cfg).toEqual({ intervalMs: 5000, maxDepth: 20, waitBudgetMs: 30000 });
  });
});
