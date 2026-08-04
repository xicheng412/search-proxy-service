import { Hono } from "hono";
import { cors } from "hono/cors";
import type { Env, AppVariables } from "./types";
import { handleLogin, handleLogout } from "./auth";
import { admin } from "./admin";
import { loginPage } from "./views";
import { handleSearch } from "./proxy";

export type { Env } from "./types";

const app = new Hono<{ Bindings: Env; Variables: AppVariables }>();

// 允许浏览器跨域调用代理端点（/search 鉴权靠请求头里的分发 key）
app.use("*", cors());

app.get("/", (c) => {
  return c.json({
    name: "tavily-cf-proxy",
    status: "ok",
    endpoints: {
      search: "POST /search",
      admin: "/admin",
    },
  });
});

// ---------- 代理链路 ----------
// 透明代理：请求端对 /search 的请求，原样改造成 Tavily 官方请求并透传结果。
// 鉴权方式与 Tavily 官方一致：Authorization: Bearer <key>（此处 key 用后台生成的分发 key）。
app.post("/search", handleSearch);

// ---------- 管理员认证 ----------
app.get("/admin/login", (c) => {
  return c.html(loginPage(c.req.query("error") === "1"));
});
app.post("/admin/login", handleLogin);
app.post("/admin/logout", handleLogout);
app.route("/admin", admin);

export default app;
