// admin 上游 key 启用/停用单测（直接驱动 tavilyAdmin 子应用，绕过挂载层的 session/CSRF）：
// - enabled→disabled：UPDATE 只写 status='disabled'，不触发 activate。
// - disabled→enabled：UPDATE 写 status='enabled' 且清 cooldown_until/suspended_cause，
//   并触发 DO `/_internal/activate`（清内存冷却），随后 notifyKeyPoolSync 全量合并。
// 断言经脚本式 fake D1 的 SQL/binds 与 QUEUE stub 的 fetch URL/body。

import { describe, it, expect } from "vitest";
import type { Env } from "../src/types";
import { TAVILY } from "../src/providers";
import { tavilyAdmin } from "../src/admin/tavily";
import { makeScriptedD1, type D1Call } from "./helpers/fake-d1";

const disabledRow = { id: "k1", key: "tvly-k1", name: "", status: "disabled", cooldown_until: 5000, suspended_cause: "breaker", created_at: 1 };
const enabledRow = { id: "k1", key: "tvly-k1", name: "", status: "enabled", cooldown_until: null, suspended_cause: null, created_at: 1 };

interface QueueCall {
  url: string;
  body: string;
}

function makeQueue() {
  const calls: QueueCall[] = [];
  const stub = {
    fetch: async (url: string, init?: { method?: string; body?: string }) => {
      calls.push({ url, body: init?.body ?? "" });
      return new Response("ok");
    },
  };
  const queue = {
    idFromName: () => "do0",
    get: () => stub,
  };
  return { calls, queue };
}

describe("admin /:id/toggle 冷却统一", () => {
  it("disabled→enabled：UPDATE 清 cooldown_until/suspended_cause，并触发 /_internal/activate", async () => {
    const { db, log } = makeScriptedD1([{ results: [disabledRow] }, { results: [enabledRow] }]);
    const { calls, queue } = makeQueue();
    const env = { DB: db, QUEUE: queue } as unknown as Env;

    const res = await tavilyAdmin.request("/k1/toggle", { method: "POST" }, env as Env, { waitUntil: () => {} } as ExecutionContext);
    expect(res.status).toBe(303);
    expect(res.headers.get("location")).toBe("/admin/tavily/list");

    // 取 UPDATE RETURNING 调用
    const update = log().find((c) => c.sql.includes("UPDATE upstream_keys"));
    expect(update).toBeDefined();
    expect(update!.sql).toContain("SET status = ?1, cooldown_until = ?2, suspended_cause = ?3");
    expect(update!.sql).toContain("RETURNING");
    expect(update!.binds).toEqual(["enabled", null, null, TAVILY.name, "k1"]);

    // 已触发 activate（清内存冷却）：URL 与 body
    const activate = calls.find((c) => c.url.includes("/_internal/activate"));
    expect(activate).toBeDefined();
    expect(JSON.parse(activate!.body)).toEqual({ provider: TAVILY.name, id: "k1" });
    // 随后触发全量合并 sync
    expect(calls.some((c) => c.url.includes("/_internal/sync-keys"))).toBe(true);
  });

  it("enabled→disabled：UPDATE 只写 status，不触发 activate", async () => {
    const enabledForDisable = { ...enabledRow, status: "enabled" };
    const disabledAfter = { ...enabledRow, status: "disabled" };
    const { db, log } = makeScriptedD1([
      { results: [enabledForDisable] },
      { results: [disabledAfter] },
    ]);
    const { calls, queue } = makeQueue();
    const env = { DB: db, QUEUE: queue } as unknown as Env;

    const res = await tavilyAdmin.request("/k1/toggle", { method: "POST" }, env as Env, { waitUntil: () => {} } as ExecutionContext);
    expect(res.status).toBe(303);
    const update = log().find((c: D1Call) => c.sql.includes("UPDATE upstream_keys"));
    expect(update!.sql).toContain("SET status = ?1");
    expect(update!.binds).toEqual(["disabled", TAVILY.name, "k1"]);
    expect(calls.some((c) => c.url.includes("/_internal/activate"))).toBe(false);
    // 停用不属「启用」，无需清内存冷却，但仍全量合并采纳 status
    expect(calls.some((c) => c.url.includes("/_internal/sync-keys"))).toBe(true);
  });

  it("未找到 key：返回错误片段，不发任何 UPDATE/QUEUE 调用", async () => {
    const { db, log } = makeScriptedD1([{ results: [] }]);
    const { calls, queue } = makeQueue();
    const env = { DB: db, QUEUE: queue } as unknown as Env;
    const res = await tavilyAdmin.request("/k1/toggle", { method: "POST" }, env as Env, { waitUntil: () => {} } as ExecutionContext);
    expect(res.status).toBe(200); // errorFragment（与其它 admin 错误一致，无显式状态码）
    expect(log().filter((c) => c.sql.includes("UPDATE"))).toHaveLength(0);
    expect(calls).toHaveLength(0);
  });
});

describe("admin GET /list 分页 + 共 N 条", () => {
  it("GET /list：list.all → count.first → usage.all；渲染共 N 条与下一页链接", async () => {
    // 21 行 > PAGE_SIZE(20) → 首页有下一页
    const pageRows = Array.from({ length: 21 }, (_, i) => ({
      id: `k${i + 1}`,
      key: `tvly-k${i + 1}`,
      name: "",
      status: "enabled",
      cooldown_until: null,
      suspended_cause: null,
      created_at: i + 1,
    }));
    const { db, log } = makeScriptedD1([
      { results: pageRows }, // list.all（keyset 首页，多取一行）
      { results: [{ total: 5, enabled: 4 }] }, // count.first（惰性总数）
      { results: [] }, // usage.all（当日统计）
    ]);
    const env = { DB: db, QUEUE: { idFromName: () => "0" } } as unknown as Env;
    const res = await tavilyAdmin.request(
      "/list",
      { method: "GET" },
      env as Env,
      { waitUntil: () => {} } as ExecutionContext
    );
    expect(res.status).toBe(200);
    const html = await res.text();
    expect(html).toContain("共 5 条");
    expect(html).toContain("下一页");
    expect(log().map((c) => c.op)).toEqual(["all", "first", "all"]);
  });
});
