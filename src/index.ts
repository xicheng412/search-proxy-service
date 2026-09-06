import { Hono } from "hono";
import { cors } from "hono/cors";
import type { Env, AppVariables } from "./types";
import { handleLogin, handleLogout } from "./auth";
import { admin } from "./admin";
import { loginPage } from "./views";
import { handleSearch, handleExtract } from "./proxy";

export type { Env } from "./types";
export { QueueDO } from "./queue";

const app = new Hono<{ Bindings: Env; Variables: AppVariables }>();

// 允许浏览器跨域调用代理端点（/search 鉴权靠请求头里的分发 key）
app.use("*", cors());

app.get("/", (c) => {
  return c.json({
    name: "tavily-cf-proxy",
    status: "ok",
    providers: ["tavily", "exa"],
    protocols: ["native", "searxng"],
    capabilities: ["search", "extract"],
    endpoints: {
      search: "GET|POST /search", // Search 能力：native POST（Bearer tavily-|exa-<key>，透传）；searxng GET|POST（Bearer searxng-tavily-<key>）
      extract: "POST /extract",   // Extract 能力：native only（Bearer tavily-<key>，Tavily Extract 透传）
      admin: "/admin",
    },
  });
});

// ---------- 代理链路 ----------
// 端点按能力、token 前缀按 provider 分派：
// - /search 承载 Search 能力（POST native 透传 Bearer <tavily|exa>-<key>；GET|POST searxng Bearer searxng-tavily-<key>）。
// - /extract 承载 Extract 能力（POST native 透传 Bearer tavily-<key>）；无 searxng 语义、exa 无此能力。
app.all("/search", handleSearch);

// /extract：Tavily Extract 透明转发（native only，Bearer tavily-<key>），
// 复用与 /search 相同的重试/熔断/用量统计链路。仅 POST。
app.post("/extract", handleExtract);

// ---------- 管理员认证 ----------
app.get("/admin/login", (c) => {
  return c.html(loginPage(c.req.query("error") === "1"));
});
app.post("/admin/login", handleLogin);
app.post("/admin/logout", handleLogout);
app.route("/admin", admin);

// 用量保留：D1 无 TTL，定时清理超 90 天的 UTC 小时桶行。小时桶价廉，每日一次足够。
const USAGE_RETENTION_DAYS = 90;

export default {
  fetch: app.fetch,
  async scheduled(
    _event: ScheduledEvent,
    env: Env,
    ctx: ExecutionContext
  ): Promise<void> {
    const cutoff =
      new Date(Date.now() - USAGE_RETENTION_DAYS * 86_400_000).toISOString().slice(0, 13) + ":00";
    await env.DB.prepare("DELETE FROM usage_counts WHERE hour < ?1").bind(cutoff).run();
  },
};
