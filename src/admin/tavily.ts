// Tavily Keys 管理路由（provider 专用文件）。所有数据操作走泛型 kv + TAVILY 描述符。

import { Hono } from "hono";
import { Env, AppVariables } from "../types";
import { getCsrfToken, validateCsrf } from "../auth";
import {
  addUpstreamKey,
  deleteUpstreamKey,
  getUpstreamStats,
  listUpstreamKeys,
  todayDate,
  updateUpstreamKey,
} from "../kv";
import { TAVILY } from "../providers";
import { errorFragment } from "../views";
import { tavilyListFragment, tavilyPage } from "../views/tavily";

export const tavilyAdmin = new Hono<{ Bindings: Env; Variables: AppVariables }>();

tavilyAdmin.get("/", async (c) => {
  const kv = c.env.KV;
  const csrf = (await getCsrfToken(c)) ?? "";
  const keys = await listUpstreamKeys(kv, TAVILY.upstream);
  const statsMap: Record<string, { success: number; fail: number }> = {};
  await Promise.all(
    keys.map(async (k) => {
      statsMap[k.id] = await getUpstreamStats(kv, k.id, todayDate());
    })
  );
  return c.html(tavilyPage(csrf, tavilyListFragment(keys, statsMap, csrf, Date.now())));
});

tavilyAdmin.get("/list", async (c) => {
  const kv = c.env.KV;
  const csrf = (await getCsrfToken(c)) ?? "";
  const keys = await listUpstreamKeys(kv, TAVILY.upstream);
  const statsMap: Record<string, { success: number; fail: number }> = {};
  await Promise.all(
    keys.map(async (k) => {
      statsMap[k.id] = await getUpstreamStats(kv, k.id, todayDate());
    })
  );
  return c.html(tavilyListFragment(keys, statsMap, csrf, Date.now()));
});

// 新增 Tavily key（可附带 test call）
tavilyAdmin.post("/add", async (c) => {
  if (!(await validateCsrf(c))) return c.html(errorFragment("CSRF 校验失败"), 403);
  const body = await c.req.parseBody();
  const key = ((body["key"] as string) ?? "").trim();
  const name = ((body["name"] as string) ?? "").trim();
  const doTest = body["test"] === "1";
  if (!key) return c.html(errorFragment("缺少 key"));
  const kv = c.env.KV;

  if (doTest) {
    try {
      const r = await fetch(TAVILY.base + TAVILY.endpoints.search, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          authorization: `Bearer ${key}`,
        },
        body: JSON.stringify(TAVILY.testBody()),
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

  await addUpstreamKey(kv, TAVILY.upstream, key, name);
  return c.redirect("/admin/tavily/list", 303);
});

tavilyAdmin.post("/:id/toggle", async (c) => {
  if (!(await validateCsrf(c))) return c.html(errorFragment("CSRF 校验失败"), 403);
  const id = c.req.param("id");
  const cur = (await listUpstreamKeys(c.env.KV, TAVILY.upstream)).find((k) => k.id === id);
  if (!cur) return c.html(errorFragment("未找到该 key"));
  await updateUpstreamKey(c.env.KV, TAVILY.upstream, id, {
    status: cur.status === "enabled" ? "disabled" : "enabled",
  });
  return c.redirect("/admin/tavily/list", 303);
});

tavilyAdmin.post("/:id/delete", async (c) => {
  if (!(await validateCsrf(c))) return c.html(errorFragment("CSRF 校验失败"), 403);
  await deleteUpstreamKey(c.env.KV, TAVILY.upstream, c.req.param("id"));
  return c.redirect("/admin/tavily/list", 303);
});
