// 管理后台根路由：鉴权中间件 + Dashboard 总览 + 挂载各业务子路由。

import { Hono } from "hono";
import { Env, AppVariables } from "../types";
import { getSession, getCsrfToken, validateCsrf } from "../auth";
import { hourKey } from "../domain";
import { countDistributedKeys } from "../storage/dist-keys";
import { countUpstreamKeys } from "../storage/upstream-keys";
import { getUsageStore } from "../usage";
import { readQueueConfig, writeQueueConfig } from "../queue/config";
import { readBreakerConfig, writeBreakerConfig } from "../breaker-config";
import { readDistCacheConfig, writeDistCacheConfig } from "../dist-cache-config";
import { EXA, TAVILY } from "../providers";
import { errorFragment } from "../views";
import { adminPage } from "../views/dashboard";
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
      ].includes(c.req.path);
    if (isPage) {
      return c.redirect("/admin/login?next=" + encodeURIComponent(c.req.path));
    }
    return c.text("Unauthorized", 401);
  }
  c.set("admin", true);
  await next();
});

// CSRF 收口：所有 admin POST 写操作统一校验 token（此前散落在 16 处 handler 内的样板
// 已删除，统一由本中间件兜住；行为不变——失败仍是 errorFragment("CSRF 校验失败") 403）。
// GET 渲染表单仍各自取 getCsrfToken 注入隐藏字段。
admin.use("*", async (c, next) => {
  if (c.req.method === "POST" && !(await validateCsrf(c))) {
    return c.html(errorFragment("CSRF 校验失败"), 403);
  }
  await next();
});


// ---------- Dashboard 总览页 ----------
admin.get("/", async (c) => {
  const env = c.env;
  const kv = c.env.KV; // 基础配置（queue/breaker）与会话仍走 KV
  const [tkeys, ekeys, dkeys] = await Promise.all([
    countUpstreamKeys(env, TAVILY.upstream),
    countUpstreamKeys(env, EXA.upstream),
    countDistributedKeys(env),
  ]);

  const store = getUsageStore(env);
  const seriesMinHour = hourKey(Date.now() - 5 * 86_400_000);
  const [distSeries, upstreamSeries] = await Promise.all([
    store.readDistSeries(seriesMinHour),
    store.readUpstreamSeries(seriesMinHour),
  ]);
  const [queueCfg, breakerCfg, distCacheCfg, csrf] = await Promise.all([
    readQueueConfig(kv),
    readBreakerConfig(kv),
    readDistCacheConfig(kv),
    getCsrfToken(c).then((t) => t ?? ""),
  ]);

  return c.html(
    adminPage({
      tavilyTotal: tkeys.total,
      tavilyEnabled: tkeys.enabled,
      exaTotal: ekeys.total,
      exaEnabled: ekeys.enabled,
      distTotal: dkeys.total,
      distEnabled: dkeys.enabled,
      distSeries: JSON.stringify(distSeries),
      upstreamSeries: JSON.stringify(upstreamSeries),
      queueIntervalMs: queueCfg.intervalMs,
      queueMaxDepth: queueCfg.maxDepth,
      queueWaitBudgetMs: queueCfg.waitBudgetMs,
      postUseCooldownSec: breakerCfg.postUseCooldownSec,
      breakerBaseSec: breakerCfg.breakerBaseSec,
      invalidCooldownSec: breakerCfg.invalidCooldownSec,
      distCacheTtlSec: distCacheCfg.cacheTtlSec,
      csrf,
    })
  );
});

// 更新上游请求队列参数（CSRF 校验 + 数值校验；写 KV，DO 侧 TTL 缓存 ≤3s 生效）
admin.post("/queue-config", async (c) => {
  const body = await c.req.parseBody();
  const intervalMs = Number(body["intervalMs"]);
  const maxDepth = Number(body["maxDepth"]);
  const waitBudgetMs = Number(body["waitBudgetMs"]);
  if (!Number.isFinite(intervalMs) || intervalMs < 100) {
    return c.html(errorFragment("间隔至少 100ms"), 400);
  }
  if (!Number.isFinite(maxDepth) || maxDepth < 1) {
    return c.html(errorFragment("最大等待数至少为 1"), 400);
  }
  if (!Number.isFinite(waitBudgetMs) || waitBudgetMs < 1000) {
    return c.html(errorFragment("等待上限至少 1000ms"), 400);
  }
  await writeQueueConfig(c.env.KV, {
    intervalMs: Math.round(intervalMs),
    maxDepth: Math.floor(maxDepth),
    waitBudgetMs: Math.round(waitBudgetMs),
  });
  return c.redirect("/admin", 303);
});

// 更新熔断/冷却参数（CSRF 校验 + 数值校验；写 KV，circuit-breaker 侧 TTL 缓存 ≤3s 生效）
admin.post("/breaker-config", async (c) => {
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

// 更新鉴权缓存 TTL（CSRF 校验 + 数值校验；缓存自然过期或写路径主动失效）
admin.post("/dist-cache-config", async (c) => {
  const body = await c.req.parseBody();
  const cacheTtlSec = Number(body["cacheTtlSec"]);
  if (!Number.isFinite(cacheTtlSec) || cacheTtlSec < 1) {
    return c.html(errorFragment("缓存 TTL 至少为 1 秒"), 400);
  }
  await writeDistCacheConfig(c.env.KV, { cacheTtlSec: Math.round(cacheTtlSec) });
  return c.redirect("/admin", 303);
});

admin.route("/tavily", tavilyAdmin);
admin.route("/exa", exaAdmin);
admin.route("/keys", keysAdmin);
