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
    // 批量操作条 + 复选框 + 全选本页（翻转/删除走整页 reload 的普通表单，非 hx-post）
    expect(html).toContain('id="batch-form"');
    expect(html).toContain('name="ids[]"');
    expect(html).toContain('id="select-all"');
    expect(html).toContain('formaction="/admin/tavily/batch-toggle"');
    expect(html).toContain('formaction="/admin/tavily/batch-delete"');
    expect(log().map((c) => c.op)).toEqual(["all", "first", "all"]);
  });
});

describe("admin upstream 批量切换/删除（batch-toggle / batch-delete）", () => {
  const postBatch = (path: string, body: string, env: Env) =>
    tavilyAdmin.request(
      path,
      { method: "POST", body, headers: { "content-type": "application/x-www-form-urlencoded" } },
      env,
      { waitUntil: () => {} } as ExecutionContext
    );

  it("batch-toggle happy path：预查 → 单条 CASE UPDATE → 全行 activate + sync", async () => {
    const { db, log } = makeScriptedD1([
      { results: [{ id: "k1" }, { id: "k2" }] }, // 存在性预查 .all()
      { changes: 2 }, // UPDATE .run()
    ]);
    const { calls, queue } = makeQueue();
    const env = { DB: db, QUEUE: queue } as unknown as Env;

    const res = await postBatch("/batch-toggle", "ids[]=k1&ids[]=k2", env);
    expect(res.status).toBe(303);
    expect(res.headers.get("location")).toBe(
      "/admin/tavily?flash=" + encodeURIComponent("已切换 2 个 key")
    );

    // 预查：SELECT id WHERE provider=? AND id IN(...,...)，binds = [provider, k1, k2]
    expect(log()[0].op).toBe("all");
    expect(log()[0].sql).toContain("SELECT id FROM upstream_keys WHERE provider = ?1 AND id IN");
    expect(log()[0].binds).toEqual([TAVILY.name, "k1", "k2"]);

    // 落盘：单条 UPDATE（翻转语义 + 条件清冷却），不再发其它写
    const update = log()[1];
    expect(update.op).toBe("run");
    expect(update.sql).toContain("CASE WHEN status = 'enabled'");
    expect(update.binds).toEqual([TAVILY.name, "k1", "k2"]);
    expect(log().filter((c) => c.op === "run")).toHaveLength(1);

    // 翻成 enabled 的行清内存冷却：每 id 一次 activate；随后一次全量 sync
    const activates = calls.filter((c) => c.url.includes("/_internal/activate"));
    expect(activates).toHaveLength(2);
    expect(JSON.parse(activates[0].body)).toEqual({ provider: TAVILY.name, id: "k1" });
    expect(JSON.parse(activates[1].body)).toEqual({ provider: TAVILY.name, id: "k2" });
    expect(calls.some((c) => c.url.includes("/_internal/sync-keys"))).toBe(true);
  });

  it("batch-toggle 预查缺失：整批拒绝，不落任何 UPDATE、不发 activate/sync", async () => {
    const { db, log } = makeScriptedD1([{ results: [] }]); // 全部缺失
    const { calls, queue } = makeQueue();
    const env = { DB: db, QUEUE: queue } as unknown as Env;

    const res = await postBatch("/batch-toggle", "ids[]=k1&ids[]=k2", env);
    expect(res.status).toBe(303);
    expect(res.headers.get("location")).toContain(encodeURIComponent("未切换"));
    expect(log().filter((c) => c.op === "run")).toHaveLength(0);
    expect(calls).toHaveLength(0);
  });

  it("batch-delete happy path：预查 → 单条 DELETE → sync，不 activate", async () => {
    const { db, log } = makeScriptedD1([
      { results: [{ id: "k1" }] },
      { changes: 1 },
    ]);
    const { calls, queue } = makeQueue();
    const env = { DB: db, QUEUE: queue } as unknown as Env;

    const res = await postBatch("/batch-delete", "ids[]=k1", env);
    expect(res.status).toBe(303);
    expect(res.headers.get("location")).toBe(
      "/admin/tavily?flash=" + encodeURIComponent("已删除 1 个 key")
    );

    const del = log().find((c) => c.op === "run");
    expect(del!.sql).toContain("DELETE FROM upstream_keys WHERE provider = ?1 AND id IN");
    expect(del!.binds).toEqual([TAVILY.name, "k1"]);
    expect(calls.some((c) => c.url.includes("/_internal/sync-keys"))).toBe(true);
    expect(calls.some((c) => c.url.includes("/_internal/activate"))).toBe(false);
  });

  it("batch-delete 预查缺失：整批拒绝，不落任何 DELETE、不发 sync", async () => {
    const { db, log } = makeScriptedD1([{ results: [] }]);
    const { calls, queue } = makeQueue();
    const env = { DB: db, QUEUE: queue } as unknown as Env;

    const res = await postBatch("/batch-delete", "ids[]=k1", env);
    expect(res.status).toBe(303);
    expect(res.headers.get("location")).toContain(encodeURIComponent("未删除"));
    expect(calls).toHaveLength(0);
  });

  it("未选择任何 key：返回错误片段，不发任何 D1/QUEUE 调用", async () => {
    const { db, log } = makeScriptedD1([]);
    const { calls, queue } = makeQueue();
    const env = { DB: db, QUEUE: queue } as unknown as Env;

    const res = await postBatch("/batch-toggle", "", env);
    expect(res.status).toBe(200);
    expect(await res.text()).toContain("未选择任何 key");
    expect(log()).toHaveLength(0);
    expect(calls).toHaveLength(0);
  });
});
