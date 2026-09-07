// 门户路由冒烟测试：钉住公开/私有边界 —— / 是纯文本导航、/help 是独立公开页
// （无 admin 外壳）、/admin 未登录 302 跳登录、旧 /admin/help 已移除返回 404。
// 走真实 src/index.ts 的 default.fetch，避免路由装配与真实行为漂移。

import { describe, it, expect } from "vitest";
import worker from "../src/index";
import type { Env } from "../src/types";

const env = {
  ADMIN_PASSWORD: "x",
  KV: { get: async () => null, put: async () => {} },
  PUBLIC_BASE_URL: "https://proxy.example",
} as unknown as Env;

function get(path: string) {
  return worker.fetch(new Request("https://proxy.example" + path), env, {
    waitUntil: () => {},
  } as unknown as ExecutionContext);
}

describe("公开门户路由（无需会话）", () => {
  it("GET / → 200 text/plain 导航文本，列出全部入口", async () => {
    const res = await get("/");
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toContain("text/plain");
    const text = await res.text();
    expect(text).toContain("/search");
    expect(text).toContain("/extract");
    expect(text).toContain("/reader/<url>");
    expect(text).toContain("/help");
    expect(text).toContain("/admin");
  });

  it("GET /help → 200 text/html，独立页面、无 admin 痕迹", async () => {
    const res = await get("/help");
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toContain("text/html");
    const html = await res.text();
    expect(html).toContain("使用说明");
    expect(html).not.toContain("管理后台");
    expect(html).not.toContain("登出");
    expect(html).not.toContain("htmx");
  });

  it("GET /admin 未登录 → 302 到登录页", async () => {
    const res = await get("/admin");
    expect(res.status).toBe(302);
    expect(res.headers.get("location")).toContain("/admin/login");
  });

  it("旧 /admin/help 已移除：不再有公开帮助页，落入 admin 鉴权门 401（未登录）", async () => {
    // 从 isPage 列表移除后未登录不再 302 跳登录；admin 全子树对未登录非页面路由统一 401（登录后才是 404）。
    const res = await get("/admin/help");
    expect(res.status).toBe(401);
    expect(res.headers.get("location")).toBeNull();
  });
});
