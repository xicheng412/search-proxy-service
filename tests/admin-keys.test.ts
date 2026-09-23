// admin /admin/keys 分发 Keys 管理路由单测（直挂 keysAdmin 子应用，绕过 session/CSRF）：
// - GET /list 第一页：keyset 首页 sql、惰性总数「共 N 条」、下一页链接（LIMIT+1 判 hasNext）。
// - GET /list?page=2&after=…：after 游标绑定、上一页(before)链接、共 N 条。
// - POST delete 带 back：303 保持当前页（重定向拼回 back query）。
// 断言经脚本式 fake D1 的 SQL/binds 与返回 HTML/location。
// 注：getUsageStore 为 per-isolate 单例，首个用例捕获其 DB 供后续 usage 读；故各页 key 不同，
//    usage 读穿到首个 db 得空结果不影响断言（用量只展示，此处不校验其数值）。

import { describe, it, expect, beforeEach } from "vitest";
import type { Env } from "../src/types";
import { keysAdmin } from "../src/admin/keys";
import { encodeCursor } from "../src/admin/pagination";
import { clearDistributedKeyCountCache } from "../src/storage/dist-keys";
import { makeScriptedD1 } from "./helpers/fake-d1";
import { installFakeCaches } from "./helpers/fake-caches";

const PAGE_SIZE = 20;

// 惰性总数缓存是模块级单例，跨用例共享 → 每例前清空，保证 count.first 落到本用例 db。
beforeEach(() => {
  clearDistributedKeyCountCache();
});

const dRow = (apiKey: string, created_at: number) => ({
  api_key: apiKey,
  note: `n-${apiKey}`,
  status: "enabled",
  created_at,
});

const makeEnv = (db: unknown) =>
  ({
    DB: db,
    KV: { get: async () => null, put: async () => {} },
    PUBLIC_BASE_URL: "https://proxy.example",
  }) as unknown as Env;

const execCtx = { waitUntil: () => {} } as unknown as ExecutionContext;

describe("admin GET /list 分发 Keys 分页", () => {
  it("第一页：list.all → count.first → usage.all；渲染共 N 条与下一页链接", async () => {
    // 21 行 > PAGE_SIZE(20) → 首页有下一页
    const pageRows = Array.from({ length: 21 }, (_, i) => dRow(`k${i + 1}`, i + 1));
    const { db, log } = makeScriptedD1([
      { results: pageRows }, // keyset 首页 .all（多取一行）
      { results: [{ total: 30, enabled: 25 }] }, // count.first
      { results: [] }, // usage.all（当日统计）
    ]);
    const res = await keysAdmin.request("/list", { method: "GET" }, makeEnv(db), execCtx);
    expect(res.status).toBe(200);
    const html = await res.text();
    expect(html).toContain("共 30 条");
    expect(html).toContain(`hx-get="/admin/keys/list?page=2&amp;after=`);
    expect(html).toContain("k1"); // 渲染 key 行（masked key）
    expect(log().map((c) => c.op)).toEqual(["all", "first", "all"]);
    // 首页 list.all 绑定 = fetchLimit（LIMIT+1）
    expect(log()[0].binds).toEqual([PAGE_SIZE + 1]);
  });

  it("after 游标页：list.all 绑定游标，渲染上一页(before)链接与共 N 条", async () => {
    // 游标 = 首页末行；PageCursor 形状 {createdAt, id}，id 即分发 api_key
    const after = { createdAt: 20, id: "k20" };
    const tok = encodeCursor(after);
    const pageRows = [dRow("k21", 21), dRow("k22", 22)];
    const { db, log } = makeScriptedD1([
      { results: pageRows }, // keyset after .all
      { results: [{ total: 30, enabled: 25 }] }, // count.first
      { results: [] }, // usage.all（穿到首个用例 db，空结果，不影响断言）
    ]);
    const res = await keysAdmin.request(
      `/list?page=2&after=${tok}`,
      { method: "GET" },
      makeEnv(db),
      execCtx
    );
    expect(res.status).toBe(200);
    const html = await res.text();
    expect(html).toContain("共 30 条");
    expect(html).toContain('hx-get="/admin/keys/list?page=1&amp;before='); // 上一页
    // after 游标绑定：after.createdAt, after.apiKey, fetchLimit
    const listCall = log().find((c) => c.op === "all");
    expect(listCall!.sql).toContain("(created_at, api_key) > (?1, ?2)");
    expect(listCall!.binds).toEqual([20, "k20", PAGE_SIZE + 1]);
  });
});

describe("admin POST delete 保持当前页", () => {
  it("body 带 back → 303 重定向拼回 back query（保持当前页）", async () => {
    installFakeCaches(); // deleteDistributedKey 需 caches.default.delete
    const after = { createdAt: 20, id: "k20" };
    const tok = encodeCursor(after);
    const { db, log } = makeScriptedD1([{ changes: 1 }]); // DELETE
    const res = await keysAdmin.request(
      `/k20/delete`,
      {
        method: "POST",
        body: new URLSearchParams({ back: `?page=2&after=${tok}` }).toString(),
        headers: { "content-type": "application/x-www-form-urlencoded" },
      },
      makeEnv(db),
      execCtx
    );
    expect(res.status).toBe(303);
    expect(res.headers.get("location")).toBe(`/admin/keys/list?page=2&after=${tok}`);
    expect(log().some((c) => c.op === "run" && c.sql.includes("DELETE FROM distributed_keys"))).toBe(true);
  });
});
