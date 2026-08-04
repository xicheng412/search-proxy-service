// 管理后台路由处理：Tavily Keys 与分发 Keys 的 HTMX 管理接口。

import { Hono } from "hono";
import { Env, AppVariables } from "./types";
import {
  getCsrfToken,
  getSession,
  validateCsrf,
} from "./auth";
import {
  addTavilyKey,
  deleteDistributedKey,
  deleteTavilyKey,
  generateDistributedKey,
  getDistCalls,
  getTavilyStats,
  listDistributedKeys,
  listTavilyKeys,
  todayDate,
  updateDistributedKey,
  updateTavilyKey,
} from "./kv";
import {
  adminPage,
  distGenerateResult,
  distListFragment,
  distViewForm,
  distViewPlain,
  errorFragment,
  keysPage,
  tavilyPage,
  tavilyListFragment,
} from "./views";

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
  const [tkeys, dkeys] = await Promise.all([listTavilyKeys(kv), listDistributedKeys(kv)]);

  let todayCalls = 0;
  await Promise.all(
    dkeys.map(async (k) => {
      todayCalls += await getDistCalls(kv, k.api_key, today);
    })
  );

  return c.html(
    adminPage({
      tavilyTotal: tkeys.length,
      tavilyEnabled: tkeys.filter((k) => k.status === "enabled").length,
      distTotal: dkeys.length,
      distEnabled: dkeys.filter((k) => k.status === "enabled").length,
      todayCalls,
      today,
    })
  );
});

// ---------- Tavily Keys ----------
admin.get("/tavily", async (c) => {
  const kv = c.env.KV;
  const csrf = (await getCsrfToken(c)) ?? "";
  const tkeys = await listTavilyKeys(kv);
  const statsMap: Record<string, { success: number; fail: number }> = {};
  await Promise.all(
    tkeys.map(async (k) => {
      statsMap[k.id] = await getTavilyStats(kv, k.id, todayDate());
    })
  );
  return c.html(tavilyPage(csrf, tavilyListFragment(tkeys, statsMap, csrf, Date.now())));
});

admin.get("/tavily/list", async (c) => {
  const kv = c.env.KV;
  const csrf = (await getCsrfToken(c)) ?? "";
  const tkeys = await listTavilyKeys(kv);
  const statsMap: Record<string, { success: number; fail: number }> = {};
  await Promise.all(
    tkeys.map(async (k) => {
      statsMap[k.id] = await getTavilyStats(kv, k.id, todayDate());
    })
  );
  return c.html(tavilyListFragment(tkeys, statsMap, csrf, Date.now()));
});

// 新增 Tavily key（可附带 test call）
admin.post("/tavily/add", async (c) => {
  if (!(await validateCsrf(c))) return c.html(errorFragment("CSRF 校验失败"), 403);
  const body = await c.req.parseBody();
  const key = ((body["key"] as string) ?? "").trim();
  const name = ((body["name"] as string) ?? "").trim();
  const doTest = body["test"] === "1";
  if (!key) return c.html(errorFragment("缺少 key"));
  const kv = c.env.KV;

  if (doTest) {
    try {
      const r = await fetch("https://api.tavily.com/search", {
        method: "POST",
        headers: {
          "content-type": "application/json",
          authorization: `Bearer ${key}`,
        },
        body: JSON.stringify({ query: "test", max_results: 1 }),
      });
      if (!r.ok) {
        return c.html(
          errorFragment(`验证未通过（HTTP ${r.status}），未添加。可手动标记为禁用。`)
        );
      }
    } catch {
      return c.html(errorFragment("验证失败（网络错误），未添加。"));
    }
  }

  await addTavilyKey(kv, key, name);
  return c.redirect("/admin/tavily/list", 303);
});

admin.post("/tavily/:id/toggle", async (c) => {
  if (!(await validateCsrf(c))) return c.html(errorFragment("CSRF 校验失败"), 403);
  const id = c.req.param("id");
  const cur = (await listTavilyKeys(c.env.KV)).find((k) => k.id === id);
  if (!cur) return c.html(errorFragment("未找到该 key"));
  await updateTavilyKey(c.env.KV, id, {
    status: cur.status === "enabled" ? "disabled" : "enabled",
  });
  return c.redirect("/admin/tavily/list", 303);
});

admin.post("/tavily/:id/delete", async (c) => {
  if (!(await validateCsrf(c))) return c.html(errorFragment("CSRF 校验失败"), 403);
  await deleteTavilyKey(c.env.KV, c.req.param("id"));
  return c.redirect("/admin/tavily/list", 303);
});

// ---------- 分发 Keys ----------
admin.get("/keys", async (c) => {
  const kv = c.env.KV;
  const csrf = (await getCsrfToken(c)) ?? "";
  const dkeys = await listDistributedKeys(kv);
  const callsMap: Record<string, number> = {};
  await Promise.all(
    dkeys.map(async (k) => {
      callsMap[k.api_key] = await getDistCalls(kv, k.api_key, todayDate());
    })
  );
  return c.html(keysPage(csrf, distListFragment(dkeys, callsMap, csrf)));
});

admin.get("/keys/list", async (c) => {
  const kv = c.env.KV;
  const csrf = (await getCsrfToken(c)) ?? "";
  const dkeys = await listDistributedKeys(kv);
  const callsMap: Record<string, number> = {};
  await Promise.all(
    dkeys.map(async (k) => {
      callsMap[k.api_key] = await getDistCalls(kv, k.api_key, todayDate());
    })
  );
  return c.html(distListFragment(dkeys, callsMap, csrf));
});

// 生成新 key（明文只显示一次）
admin.post("/keys/generate", async (c) => {
  if (!(await validateCsrf(c))) return c.html(errorFragment("CSRF 校验失败"), 403);
  const body = await c.req.parseBody();
  const note = ((body["note"] as string) ?? "").trim();
  if (!note) return c.html(errorFragment("备注必填"));
  const kv = c.env.KV;
  const generated = await generateDistributedKey(kv, note);
  const dkeys = await listDistributedKeys(kv);
  const callsMap: Record<string, number> = {};
  await Promise.all(
    dkeys.map(async (k) => {
      callsMap[k.api_key] = await getDistCalls(kv, k.api_key, todayDate());
    })
  );
  const csrf = (await getCsrfToken(c)) ?? "";
  return c.html(distGenerateResult(generated.api_key, dkeys, callsMap, csrf));
});

// 查看明文（首查或二次密码确认）
admin.post("/keys/:apiKey/view", async (c) => {
  if (!(await validateCsrf(c))) return c.html(errorFragment("CSRF 校验失败"), 403);
  const apiKey = c.req.param("apiKey");
  const kv = c.env.KV;
  const found = (await listDistributedKeys(kv)).find((k) => k.api_key === apiKey);
  if (!found) return c.html(errorFragment("未找到该 key"));
  const body = await c.req.parseBody();
  const password = ((body["password"] as string) ?? "").trim();

  // 首次查看：若从未查看过明文且未带密码，直接返回明文（生成后的一次机会）
  if (!found.plain_viewed && !password) {
    await updateDistributedKey(kv, apiKey, { plain_viewed: true });
    return c.html(distViewPlain(apiKey));
  }
  // 已查看过：必须二次输入密码确认
  if (!c.env.ADMIN_PASSWORD || password !== c.env.ADMIN_PASSWORD) {
    const csrf = (await getCsrfToken(c)) ?? "";
    return c.html(errorFragment("密码错误") + distViewForm(csrf, apiKey));
  }
  return c.html(distViewPlain(apiKey));
});

admin.post("/keys/:apiKey/toggle", async (c) => {
  if (!(await validateCsrf(c))) return c.html(errorFragment("CSRF 校验失败"), 403);
  const apiKey = c.req.param("apiKey");
  const cur = (await listDistributedKeys(c.env.KV)).find((k) => k.api_key === apiKey);
  if (!cur) return c.html(errorFragment("未找到该 key"));
  await updateDistributedKey(c.env.KV, apiKey, {
    status: cur.status === "enabled" ? "disabled" : "enabled",
  });
  return c.redirect("/admin/keys/list", 303);
});

admin.post("/keys/:apiKey/delete", async (c) => {
  if (!(await validateCsrf(c))) return c.html(errorFragment("CSRF 校验失败"), 403);
  await deleteDistributedKey(c.env.KV, c.req.param("apiKey"));
  return c.redirect("/admin/keys/list", 303);
});

// 完整后台挂在 /admin 下。注意登录/登出由外层 index.ts 处理（不要求登录的例外）。
