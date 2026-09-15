import { Hono } from "hono";
import { cors } from "hono/cors";
import type { Env, AppVariables } from "./types";
import { handleSearch, handleExtract, handleReader } from "./proxy";
import { resolvePublicBaseUrl } from "./config";
import { helpPage } from "./views/help";
import { handleLogin, handleLogout } from "./auth";
import { admin } from "./admin";
import { loginPage } from "./views/login";

export type { Env } from "./types";
export { QueueDO } from "./queue/durable-object";

const app = new Hono<{ Bindings: Env; Variables: AppVariables }>();

// 允许浏览器跨域调用代理端点（/search 鉴权靠请求头里的分发 key）
app.use("*", cors());

app.get("/", (c) => {
  return c.text(
`Tavily / Exa API 密钥代理服务

本服务是一个中间代理：上游真实 key（Tavily / Exa 官方 key）收口在本服务，
向外只签发可独立管控的分发 key。调用时用
Authorization: Bearer <前缀>-<key>   前缀选 provider、端点选能力。

访问入口：
- /help           使用说明（curl 示例、调用前缀、错误表）——公开，无需登录
- /admin          管理后台（上游 key / 分发 key / 统计）——需管理员登录
- /search         搜索（Search 能力）：POST native（Bearer tavily-<key>|exa-<key>）
                    或 GET|POST searxng（Bearer searxng-tavily-<key>）
- /extract        提取（Extract 能力，仅 Tavily）：POST native（Bearer tavily-<key>）
- /reader/<url>   页面正文（Extract 能力，reader 协议）：GET（Bearer reader-tavily-<key>）

继续操作：想知道怎么调用 → 访问 /help；想管理 key / 看统计 → 访问 /admin。`
  );
});

// 公开使用说明页：独立于管理后台（自带样式，无 admin 依赖），无需登录；admin 顶栏「使用说明」新标签打开。
app.get("/help", (c) => {
  return c.html(helpPage(resolvePublicBaseUrl(c.env)));
});

// ---------- 代理链路 ----------
// 端点按能力、token 前缀按 provider 分派：
// - /search 承载 Search 能力（POST native 透传 Bearer <tavily|exa>-<key>；GET|POST searxng Bearer searxng-tavily-<key>）。
// - /extract 承载 Extract 能力（POST native 透传 Bearer tavily-<key>）；无 searxng 语义、exa 无此能力。
// - /reader 承载 Extract 能力（GET reader 协议 Bearer reader-tavily-<key>，URL→文本）。
app.all("/search", handleSearch);

// /extract：Tavily Extract 透明转发（native only，Bearer tavily-<key>），
// 复用与 /search 相同的重试/熔断/用量统计链路。仅 POST。
app.post("/extract", handleExtract);

// /reader：URL→文本（reader 协议，Bearer reader-tavily-<key>），后端 Tavily Extract，
// 复用与 /search、/extract 相同的重试/熔断/用量统计链路。仅 GET；目标 URL 在路径里。
app.get("/reader/*", handleReader);

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
