// 管理后台根路由：鉴权中间件 + Dashboard 总览 + 挂载各业务子路由。

import { Hono } from "hono";
import { Env, AppVariables } from "../types";
import { getSession } from "../auth";
import {
  getDistCalls,
  listDistributedKeys,
  listUpstreamKeys,
  todayDate,
} from "../kv";
import { EXA, TAVILY } from "../providers";
import { adminPage } from "../views";
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
  await Promise.all(
    dkeys.map(async (k) => {
      const s = await getDistCalls(kv, k.api_key, today);
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
    })
  );
});

admin.route("/tavily", tavilyAdmin);
admin.route("/exa", exaAdmin);
admin.route("/keys", keysAdmin);
