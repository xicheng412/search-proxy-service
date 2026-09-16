// 组装点：只负责把各子应用挂到总路由上，不含任何内联路由/中间件。
// - /         → publicApp（门户文本 + /help）
// - /         → proxyApp（数据面 /search /extract /reader，含 cors + authenticate）
// - /admin    → adminAuth（login/logout，无守卫，先挂避免被 admin 守卫遮蔽）
// - /admin    → admin（管理后台，含会话守卫 + CSRF 中间件）
// 数据面拆分为独立子应用后，cors 只作用于代理端点（行为收敛，见 routes/proxy.ts）。

import { Hono } from "hono";
import type { Env, AppVariables } from "./types";
import { publicApp } from "./routes/public";
import { proxyApp } from "./routes/proxy";
import { adminAuth } from "./routes/admin-auth";
import { admin } from "./admin";

export type { Env } from "./types";
export { QueueDO } from "./queue/durable-object";

const app = new Hono<{ Bindings: Env; Variables: AppVariables }>();

app.route("/", publicApp);
app.route("/", proxyApp);
app.route("/admin", adminAuth);
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
