// Tavily Keys 管理路由（provider 专用文件）。所有数据操作走泛型 env + TAVILY 描述符。

import { Hono } from "hono";
import type { Context } from "hono";
import { Env, AppVariables } from "../types";
import { getCsrfToken } from "../auth";
import { autoKeyName, utcTodayStart } from "../domain";
import {
  addUpstreamKey,
  addUpstreamKeysBatch,
  deleteUpstreamKey,
  deleteUpstreamKeysBatch,
  getUpstreamKey,
  keyValueExists,
  listUpstreamKeysPage,
  missingUpstreamKeyIds,
  toggleUpstreamKeysBatch,
  UpstreamKeyPage,
  updateUpstreamKey,
} from "../storage/upstream-keys";
import { getUsageStore } from "../usage";
import { notifyKeyPoolActivate, notifyKeyPoolSync } from "../key-pool";
import { TAVILY } from "../providers";
import { errorFragment } from "../views";
import {
  PAGE_SIZE,
  buildPagination,
  parsePageQuery,
} from "./pagination";
import { tavilyListFragment, tavilyPage } from "../views/tavily";
import { cachedUpstreamKeyCount } from "../storage/upstream-keys";

export const tavilyAdmin = new Hono<{ Bindings: Env; Variables: AppVariables }>();

/** 读取当前页 key 并返回分页结果；query 参数非法时返回 400，不访问 D1。 */
async function loadUpstreamPage(
  c: Context<{ Bindings: Env; Variables: AppVariables }>
): Promise<Response | { pageNumber: number; page: UpstreamKeyPage }> {
  const query = parsePageQuery(c);
  if (!query.ok) return c.html(errorFragment(query.message), 400);
  let page: UpstreamKeyPage;
  try {
    page = await listUpstreamKeysPage(c.env, TAVILY.upstream, {
      after: query.after,
      before: query.before,
      limit: PAGE_SIZE,
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
  const total = await cachedUpstreamKeyCount(c.env, TAVILY.upstream);
  const statsMap = await getUsageStore(c.env).readUpstreamTodayStats(
    page.keys.map((k) => k.id),
    utcTodayStart()
  );
  const pagination = buildPagination("/admin/tavily", pageNumber, page);
  const flash = c.req.query("flash") ?? undefined;
  return c.html(
    tavilyPage(csrf, tavilyListFragment(page.keys, statsMap, csrf, Date.now(), pagination, flash, total))
  );
});

tavilyAdmin.get("/list", async (c) => {
  const loaded = await loadUpstreamPage(c);
  if (loaded instanceof Response) return loaded;
  const { pageNumber, page } = loaded;
  const csrf = (await getCsrfToken(c)) ?? "";
  const total = await cachedUpstreamKeyCount(c.env, TAVILY.upstream);
  const statsMap = await getUsageStore(c.env).readUpstreamTodayStats(
    page.keys.map((k) => k.id),
    utcTodayStart()
  );
  const pagination = buildPagination("/admin/tavily", pageNumber, page);
  const flash = c.req.query("flash") ?? undefined;
  return c.html(tavilyListFragment(page.keys, statsMap, csrf, Date.now(), pagination, flash, total));
});

// 新增 Tavily key（可附带 test call；name 可选，未填则自动生成）
tavilyAdmin.post("/add", async (c) => {
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

  if (await keyValueExists(env, TAVILY.upstream, key)) {
    return c.html(errorFragment("该 key 已存在，未添加"));
  }

  await addUpstreamKey(env, TAVILY.upstream, key, name);
  await notifyKeyPoolSync(c.env, TAVILY.name).catch(() => {});
  return c.redirect("/admin/tavily/list", 303);
});

// 批量添加 Tavily keys（逗号或换行分隔；name 前缀可选，未填则自动生成）
tavilyAdmin.post("/add/batch", async (c) => {
  const body = await c.req.parseBody();
  const keysText = ((body["keys"] as string) ?? "").trim();
  const namePrefix = ((body["name"] as string) ?? "").trim();
  if (!keysText) return c.html(errorFragment("缺少 key"));

  const rawKeys = keysText.split(/[\n,]+/).map((k) => k.trim()).filter(Boolean);
  if (rawKeys.length === 0) return c.html(errorFragment("未解析到有效 key"));

  const env = c.env;
  const pad = String(rawKeys.length).length;
  const res = await addUpstreamKeysBatch(
    env,
    TAVILY.upstream,
    rawKeys.map((key, i) => ({
      key,
      name: namePrefix ? `${namePrefix}-${String(i + 1).padStart(pad, "0")}` : autoKeyName(),
    }))
  );
  let msg = `添加 ${res.added.length} 个`;
  if (res.duplicates.length)
    msg += `，跳过 ${res.duplicates.length} 个重复：第 ${res.duplicates.map((d) => d.index).join("、")} 行（${res.duplicates[0].maskedKey} 等已存在）`;
  await notifyKeyPoolSync(c.env, TAVILY.name).catch(() => {});
  return c.redirect(`/admin/tavily/list?flash=${encodeURIComponent(msg)}`, 303);
});

tavilyAdmin.post("/:id/name", async (c) => {
  const id = c.req.param("id");
  const body = await c.req.parseBody();
  const name = (((body["name"] as string) ?? "").trim() || "未命名");
  const cur = await getUpstreamKey(c.env, TAVILY.upstream, id);
  if (!cur) return c.html(errorFragment("未找到该 key"));
  await updateUpstreamKey(c.env, TAVILY.upstream, id, { name });
  await notifyKeyPoolSync(c.env, TAVILY.name).catch(() => {});
  return c.redirect("/admin/tavily/list", 303);
});

tavilyAdmin.post("/:id/toggle", async (c) => {
  const id = c.req.param("id");
  const cur = await getUpstreamKey(c.env, TAVILY.upstream, id);
  if (!cur) return c.html(errorFragment("未找到该 key"));
  const disabling = cur.status === "enabled";
  await updateUpstreamKey(c.env, TAVILY.upstream, id,
    disabling
      ? { status: "disabled" }
      : { status: "enabled", cooldown_until: null, suspended_cause: null });
  // 启用：先清内存冷却（reload 刻意保留内存冷却，故须显式 activate），再全量合并采纳 status。
  if (!disabling) await notifyKeyPoolActivate(c.env, TAVILY.name, id).catch(() => {});
  await notifyKeyPoolSync(c.env, TAVILY.name).catch(() => {});
  return c.redirect("/admin/tavily/list", 303);
});

tavilyAdmin.post("/:id/delete", async (c) => {
  await deleteUpstreamKey(c.env, TAVILY.upstream, c.req.param("id"));
  await notifyKeyPoolSync(c.env, TAVILY.name).catch(() => {});
  return c.redirect("/admin/tavily/list", 303);
});

/** 归一化表单多值 ids（复选框同名多值；Hono parseBody 单值 string、多值数组，去空去重）。 */
function normalizeBatchIds(raw: unknown): string[] {
  const list = Array.isArray(raw) ? raw : raw != null ? [raw] : [];
  return [...new Set(list.map((v) => String(v)).filter((v) => v.length > 0))];
}

// 批量翻转（enabled↔disabled）：存在性预查，缺失即整批拒绝；单条 UPDATE 翻转+清冷却；
// 翻成 enabled 的行须清内存冷却（对全部 activate 无害），再全量合并 status。
tavilyAdmin.post("/batch-toggle", async (c) => {
  const body = await c.req.parseBody();
  const ids = normalizeBatchIds(body["ids[]"]);
  if (ids.length === 0) return c.html(errorFragment("未选择任何 key"));
  const env = c.env;
  const missing = await missingUpstreamKeyIds(env, TAVILY.upstream, ids);
  if (missing.length) {
    return c.redirect(
      `/admin/tavily?flash=${encodeURIComponent(`已选 ${ids.length} 个，其中 ${missing.length} 个不存在，未切换任何 key`)}`,
      303
    );
  }
  const changed = await toggleUpstreamKeysBatch(env, TAVILY.upstream, ids);
  for (const id of ids) await notifyKeyPoolActivate(c.env, TAVILY.name, id).catch(() => {});
  await notifyKeyPoolSync(c.env, TAVILY.name).catch(() => {});
  return c.redirect(
    `/admin/tavily?flash=${encodeURIComponent(`已切换 ${changed} 个 key`)}`,
    303
  );
});

// 批量删除：存在性预查，缺失即整批拒绝；单条 DELETE；全量合并 status。
tavilyAdmin.post("/batch-delete", async (c) => {
  const body = await c.req.parseBody();
  const ids = normalizeBatchIds(body["ids[]"]);
  if (ids.length === 0) return c.html(errorFragment("未选择任何 key"));
  const env = c.env;
  const missing = await missingUpstreamKeyIds(env, TAVILY.upstream, ids);
  if (missing.length) {
    return c.redirect(
      `/admin/tavily?flash=${encodeURIComponent(`已选 ${ids.length} 个，其中 ${missing.length} 个不存在，未删除任何 key`)}`,
      303
    );
  }
  const changed = await deleteUpstreamKeysBatch(env, TAVILY.upstream, ids);
  await notifyKeyPoolSync(c.env, TAVILY.name).catch(() => {});
  return c.redirect(
    `/admin/tavily?flash=${encodeURIComponent(`已删除 ${changed} 个 key`)}`,
    303
  );
});
