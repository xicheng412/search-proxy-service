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
    providers: ["tavily", "exa"],
    protocols: ["native", "searxng"],
    endpoints: {
      search: "GET|POST /search", // native: POST Bearer <tavily|exa>-<key>；searxng: GET|POST Bearer searxng-tavily-<key>
      admin: "/admin",
    },
  });
});

// ---------- 代理链路 ----------
// 透明代理 + searxng 兼容：请求端对 /search 的请求按 token 前缀分派。
// - native 透传（POST）：Bearer <tavily|exa>-<key>，原样透传上游协议。
// - searxng 兼容（GET|POST）：Bearer searxng-tavily-<key>，入参/返回值按 SearXNG 标准。
app.all("/search", handleSearch);

// ---------- 管理员认证 ----------
app.get("/admin/login", (c) => {
  return c.html(loginPage(c.req.query("error") === "1"));
});
app.post("/admin/login", handleLogin);
app.post("/admin/logout", handleLogout);
app.route("/admin", admin);

export default app;
