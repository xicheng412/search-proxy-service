// Tavily Keys 管理路由（provider 专用文件）。所有数据操作走泛型 env + TAVILY 描述符。

import { Hono } from "hono";
import type { Context } from "hono";
import { Env, AppVariables } from "../types";
import { getCsrfToken, validateCsrf } from "../auth";
import { autoKeyName, utcTodayStart } from "../domain";
import {
  addUpstreamKey,
  deleteUpstreamKey,
  getUpstreamKey,
  listUpstreamKeysPage,
  UpstreamKeyPage,
  updateUpstreamKey,
} from "../storage/upstream-keys";
import { getUsageStore } from "../usage-store";
import { TAVILY } from "../providers";
import { errorFragment } from "../views";
import {
  UPSTREAM_PAGE_SIZE,
  buildUpstreamPagination,
  parseUpstreamPageQuery,
} from "./pagination";
import { tavilyListFragment, tavilyPage } from "../views/tavily";

export const tavilyAdmin = new Hono<{ Bindings: Env; Variables: AppVariables }>();

/** 读取当前页 key 并返回分页结果；query 参数非法时返回 400，不访问 D1。 */
async function loadUpstreamPage(
  c: Context<{ Bindings: Env; Variables: AppVariables }>
): Promise<Response | { pageNumber: number; page: UpstreamKeyPage }> {
  const query = parseUpstreamPageQuery(c);
  if (!query.ok) return c.html(errorFragment(query.message), 400);
  let page: UpstreamKeyPage;
  try {
    page = await listUpstreamKeysPage(c.env, TAVILY.upstream, {
      after: query.after,
      before: query.before,
      limit: UPSTREAM_PAGE_SIZE,
    });
  } catch {
    return c.html(errorFragment("参数错误"), 400);
  }
  return { pageNumber: query.page, page };
}

tavilyAdmin.get("/", async (c) => {
  const loaded = await loadUpstreamPage(c);
  if (loaded instanceof Response) return loaded;
  const { pageNumber, page } = loaded;
  const csrf = (await getCsrfToken(c)) ?? "";
  const statsMap = await getUsageStore(c.env).readUpstreamTodayStats(
    page.keys.map((k) => k.id),
    utcTodayStart()
  );
  const pagination = buildUpstreamPagination("/admin/tavily", pageNumber, page);
  return c.html(
    tavilyPage(csrf, tavilyListFragment(page.keys, statsMap, csrf, Date.now(), pagination))
  );
});

tavilyAdmin.get("/list", async (c) => {
  const loaded = await loadUpstreamPage(c);
  if (loaded instanceof Response) return loaded;
  const { pageNumber, page } = loaded;
  const csrf = (await getCsrfToken(c)) ?? "";
  const statsMap = await getUsageStore(c.env).readUpstreamTodayStats(
    page.keys.map((k) => k.id),
    utcTodayStart()
  );
  const pagination = buildUpstreamPagination("/admin/tavily", pageNumber, page);
  return c.html(tavilyListFragment(page.keys, statsMap, csrf, Date.now(), pagination));
});

// 新增 Tavily key（可附带 test call；name 可选，未填则自动生成）
tavilyAdmin.post("/add", async (c) => {
  if (!(await validateCsrf(c))) return c.html(errorFragment("CSRF 校验失败"), 403);
  const body = await c.req.parseBody();
  const key = ((body["key"] as string) ?? "").trim();
  let name = ((body["name"] as string) ?? "").trim();
  const doTest = body["test"] === "1";
  if (!key) return c.html(errorFragment("缺少 key"));
  if (!name) name = autoKeyName();
  const env = c.env;

  if (doTest) {
    try {
      const r = await fetch(TAVILY.base + TAVILY.capabilities.search!.path, {
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

  await addUpstreamKey(env, TAVILY.upstream, key, name);
  return c.redirect("/admin/tavily/list", 303);
});

// 批量添加 Tavily keys（逗号或换行分隔；name 前缀可选，未填则自动生成）
tavilyAdmin.post("/add/batch", async (c) => {
  if (!(await validateCsrf(c))) return c.html(errorFragment("CSRF 校验失败"), 403);
  const body = await c.req.parseBody();
  const keysText = ((body["keys"] as string) ?? "").trim();
  const namePrefix = ((body["name"] as string) ?? "").trim();
  if (!keysText) return c.html(errorFragment("缺少 key"));

  const rawKeys = keysText.split(/[\n,]+/).map((k) => k.trim()).filter(Boolean);
  if (rawKeys.length === 0) return c.html(errorFragment("未解析到有效 key"));

  const env = c.env;
  const pad = String(rawKeys.length).length;
  for (let i = 0; i < rawKeys.length; i++) {
    const key = rawKeys[i];
    const name = namePrefix
      ? `${namePrefix}-${String(i + 1).padStart(pad, "0")}`
      : autoKeyName();
    await addUpstreamKey(env, TAVILY.upstream, key, name);
  }

  return c.redirect("/admin/tavily/list", 303);
});

tavilyAdmin.post("/:id/name", async (c) => {
  if (!(await validateCsrf(c))) return c.html(errorFragment("CSRF 校验失败"), 403);
  const id = c.req.param("id");
  const body = await c.req.parseBody();
  const name = (((body["name"] as string) ?? "").trim() || "未命名");
  const cur = await getUpstreamKey(c.env, TAVILY.upstream, id);
  if (!cur) return c.html(errorFragment("未找到该 key"));
  await updateUpstreamKey(c.env, TAVILY.upstream, id, { name });
  return c.redirect("/admin/tavily/list", 303);
});

tavilyAdmin.post("/:id/toggle", async (c) => {
  if (!(await validateCsrf(c))) return c.html(errorFragment("CSRF 校验失败"), 403);
  const id = c.req.param("id");
  const cur = await getUpstreamKey(c.env, TAVILY.upstream, id);
  if (!cur) return c.html(errorFragment("未找到该 key"));
  await updateUpstreamKey(c.env, TAVILY.upstream, id, {
    status: cur.status === "enabled" ? "disabled" : "enabled",
  });
  return c.redirect("/admin/tavily/list", 303);
});

tavilyAdmin.post("/:id/delete", async (c) => {
  if (!(await validateCsrf(c))) return c.html(errorFragment("CSRF 校验失败"), 403);
  await deleteUpstreamKey(c.env, TAVILY.upstream, c.req.param("id"));
  return c.redirect("/admin/tavily/list", 303);
});
