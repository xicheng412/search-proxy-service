// 管理后台根路由：鉴权中间件 + Dashboard 总览 + 挂载各业务子路由。

import { Hono } from "hono";
import { Env, AppVariables } from "../types";
import { getSession, getCsrfToken, validateCsrf } from "../auth";
import { todayDate } from "../domain";
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
  const kv = c.env.KV;
  const today = todayDate();
  const [tkeys, ekeys, dkeys] = await Promise.all([
    listUpstreamKeys(kv, TAVILY.upstream),
    listUpstreamKeys(kv, EXA.upstream),
    listDistributedKeys(kv),
  ]);

  let todayCalls = 0;
  const store = getUsageStore(kv);
  await Promise.all(
    dkeys.map(async (k) => {
      const s = await store.readDistCalls(k.api_key, today);
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
      postUseCooldownMs: (await readBreakerConfig(kv)).postUseCooldownMs,
      breakerBaseMs: (await readBreakerConfig(kv)).breakerBaseMs,
      invalidCooldownMs: (await readBreakerConfig(kv)).invalidCooldownMs,
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
  const postUseCooldownMs = Number(body["postUseCooldownMs"]);
  const breakerBaseMs = Number(body["breakerBaseMs"]);
  const invalidCooldownMs = Number(body["invalidCooldownMs"]);
  if (!Number.isFinite(postUseCooldownMs) || postUseCooldownMs < 0) {
    return c.html(errorFragment("冷却时长至少为 0ms"), 400);
  }
  if (!Number.isFinite(breakerBaseMs) || breakerBaseMs < 1000) {
    return c.html(errorFragment("熔断基数至少 1000ms"), 400);
  }
  if (!Number.isFinite(invalidCooldownMs) || invalidCooldownMs < 1000) {
    return c.html(errorFragment("疑似失效冷却至少 1000ms"), 400);
  }
  await writeBreakerConfig(c.env.KV, {
    postUseCooldownMs: Math.round(postUseCooldownMs),
    breakerBaseMs: Math.round(breakerBaseMs),
    invalidCooldownMs: Math.round(invalidCooldownMs),
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
