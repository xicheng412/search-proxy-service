// 管理后台根路由：鉴权中间件 + Dashboard 总览 + 挂载各业务子路由。

import { Hono } from "hono";
import { Env, AppVariables } from "../types";
import { getSession, getCsrfToken, validateCsrf } from "../auth";
import { todayDate, utcTodayStart } from "../domain";
import { listDistributedKeys, listUpstreamKeys } from "../storage";
import { getUsageStore } from "../usage-store";
import { resolvePublicBaseUrl } from "../config";
import { readQueueConfig, writeQueueConfig } from "../queue-config";
import { readBreakerConfig, writeBreakerConfig } from "../breaker-config";
import { EXA, TAVILY } from "../providers";
import { adminPage, errorFragment, helpPage } from "../views";
import { exaAdmin } from "./exa";
import { keysAdmin } from "./keys";
import { tavilyAdmin } from "./tavily";

export const admin = new Hono<{ Bindings: Env; Variables: AppVariables }>();

// 管理接口鉴权：页面 GET 未登录 → 302 跳登录；其余（HTMX 片段/写操作）→ 401。
admin.use("*", async (c, next) => {
  const session = await getSession(c);
  if (!session) {
    const isPage =
      c.req.method === "GET" &&
      [
        "/admin",
        "/admin/",
        "/admin/tavily",
        "/admin/tavily/",
        "/admin/exa",
        "/admin/exa/",
        "/admin/keys",
        "/admin/keys/",
        "/admin/help",
        "/admin/help/",
      ].includes(c.req.path);
    if (isPage) {
      return c.redirect("/admin/login?next=" + encodeURIComponent(c.req.path));
    }
    return c.text("Unauthorized", 401);
  }
  c.set("admin", true);
  await next();
});

// ---------- Dashboard 总览页 ----------
admin.get("/", async (c) => {
  const env = c.env;
  const kv = c.env.KV; // 基础配置（queue/breaker）与会话仍走 KV
  const today = todayDate();
  const minHour = utcTodayStart();
  const [tkeys, ekeys, dkeys] = await Promise.all([
    listUpstreamKeys(env, TAVILY.upstream),
    listUpstreamKeys(env, EXA.upstream),
    listDistributedKeys(env),
  ]);

  let todayCalls = 0;
  const store = getUsageStore(env);
  await Promise.all(
    dkeys.map(async (k) => {
      const s = await store.readDistCalls(k.api_key, minHour);
      todayCalls += s.tavily + s.exa;
    })
  );

  return c.html(
    adminPage({
      tavilyTotal: tkeys.length,
      tavilyEnabled: tkeys.filter((k) => k.status === "enabled").length,
      exaTotal: ekeys.length,
      exaEnabled: ekeys.filter((k) => k.status === "enabled").length,
      distTotal: dkeys.length,
      distEnabled: dkeys.filter((k) => k.status === "enabled").length,
      todayCalls,
      today,
      queueIntervalMs: (await readQueueConfig(kv)).intervalMs,
      queueMaxDepth: (await readQueueConfig(kv)).maxDepth,
      postUseCooldownSec: (await readBreakerConfig(kv)).postUseCooldownSec,
      breakerBaseSec: (await readBreakerConfig(kv)).breakerBaseSec,
      invalidCooldownSec: (await readBreakerConfig(kv)).invalidCooldownSec,
      csrf: (await getCsrfToken(c)) ?? "",
    })
  );
});

// 更新上游请求队列参数（CSRF 校验 + 数值校验；写 KV，DO 侧 TTL 缓存 ≤3s 生效）
admin.post("/queue-config", async (c) => {
  if (!(await validateCsrf(c))) return c.html(errorFragment("CSRF 校验失败"), 403);
  const body = await c.req.parseBody();
  const intervalMs = Number(body["intervalMs"]);
  const maxDepth = Number(body["maxDepth"]);
  if (!Number.isFinite(intervalMs) || intervalMs < 100) {
    return c.html(errorFragment("间隔至少 100ms"), 400);
  }
  if (!Number.isFinite(maxDepth) || maxDepth < 1) {
    return c.html(errorFragment("最大等待数至少为 1"), 400);
  }
  await writeQueueConfig(c.env.KV, {
    intervalMs: Math.round(intervalMs),
    maxDepth: Math.floor(maxDepth),
  });
  return c.redirect("/admin", 303);
});

// 更新熔断/冷却参数（CSRF 校验 + 数值校验；写 KV，circuit-breaker 侧 TTL 缓存 ≤3s 生效）
admin.post("/breaker-config", async (c) => {
  if (!(await validateCsrf(c))) return c.html(errorFragment("CSRF 校验失败"), 403);
  const body = await c.req.parseBody();
  const postUseCooldownSec = Number(body["postUseCooldownSec"]);
  const breakerBaseSec = Number(body["breakerBaseSec"]);
  const invalidCooldownSec = Number(body["invalidCooldownSec"]);
  if (!Number.isFinite(postUseCooldownSec) || postUseCooldownSec < 0) {
    return c.html(errorFragment("冷却时长至少为 0 秒"), 400);
  }
  if (!Number.isFinite(breakerBaseSec) || breakerBaseSec < 1) {
    return c.html(errorFragment("熔断基数至少为 1 秒"), 400);
  }
  if (!Number.isFinite(invalidCooldownSec) || invalidCooldownSec < 1) {
    return c.html(errorFragment("疑似失效冷却至少为 1 秒"), 400);
  }
  await writeBreakerConfig(c.env.KV, {
    postUseCooldownSec: Math.round(postUseCooldownSec),
    breakerBaseSec: Math.round(breakerBaseSec),
    invalidCooldownSec: Math.round(invalidCooldownSec),
  });
  return c.redirect("/admin", 303);
});

admin.route("/tavily", tavilyAdmin);
admin.route("/exa", exaAdmin);
admin.route("/keys", keysAdmin);

// ---------- 使用说明页 ----------
admin.get("/help", async (c) => {
  return c.html(helpPage(resolvePublicBaseUrl(c.env)));
});
