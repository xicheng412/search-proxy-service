// Exa Keys 管理路由（provider 专用文件）。所有数据操作走泛型 env + EXA 描述符。

import { Hono } from "hono";
import type { Context } from "hono";
import { Env, AppVariables } from "../types";
import { getCsrfToken } from "../auth";
import { autoKeyName, utcTodayStart } from "../domain";
import {
  addUpstreamKey,
  addUpstreamKeysBatch,
  deleteUpstreamKey,
  getUpstreamKey,
  keyValueExists,
  listUpstreamKeysPage,
  UpstreamKeyPage,
  updateUpstreamKey,
} from "../storage/upstream-keys";
import { getUsageStore } from "../usage";
import { notifyKeyPoolActivate, notifyKeyPoolSync } from "../key-pool";
import { EXA } from "../providers";
import { errorFragment } from "../views";
import {
  PAGE_SIZE,
  buildPagination,
  parsePageQuery,
} from "./pagination";
import { exaListFragment, exaPage } from "../views/exa";
import { cachedUpstreamKeyCount } from "../storage/upstream-keys";

export const exaAdmin = new Hono<{ Bindings: Env; Variables: AppVariables }>();

/** 读取当前页 key 并返回分页结果；query 参数非法时返回 400，不访问 D1。 */
async function loadUpstreamPage(
  c: Context<{ Bindings: Env; Variables: AppVariables }>
): Promise<Response | { pageNumber: number; page: UpstreamKeyPage }> {
  const query = parsePageQuery(c);
  if (!query.ok) return c.html(errorFragment(query.message), 400);
  let page: UpstreamKeyPage;
  try {
    page = await listUpstreamKeysPage(c.env, EXA.upstream, {
      after: query.after,
      before: query.before,
      limit: PAGE_SIZE,
    });
  } catch {
    return c.html(errorFragment("参数错误"), 400);
  }
  return { pageNumber: query.page, page };
}

exaAdmin.get("/", async (c) => {
  const loaded = await loadUpstreamPage(c);
  if (loaded instanceof Response) return loaded;
  const { pageNumber, page } = loaded;
  const csrf = (await getCsrfToken(c)) ?? "";
  const total = await cachedUpstreamKeyCount(c.env, EXA.upstream);
  const statsMap = await getUsageStore(c.env).readUpstreamTodayStats(
    page.keys.map((k) => k.id),
    utcTodayStart()
  );
  const pagination = buildPagination("/admin/exa", pageNumber, page);
  const flash = c.req.query("flash") ?? undefined;
  return c.html(
    exaPage(csrf, exaListFragment(page.keys, statsMap, csrf, Date.now(), pagination, flash, total))
  );
});

exaAdmin.get("/list", async (c) => {
  const loaded = await loadUpstreamPage(c);
  if (loaded instanceof Response) return loaded;
  const { pageNumber, page } = loaded;
  const csrf = (await getCsrfToken(c)) ?? "";
  const total = await cachedUpstreamKeyCount(c.env, EXA.upstream);
  const statsMap = await getUsageStore(c.env).readUpstreamTodayStats(
    page.keys.map((k) => k.id),
    utcTodayStart()
  );
  const pagination = buildPagination("/admin/exa", pageNumber, page);
  const flash = c.req.query("flash") ?? undefined;
  return c.html(exaListFragment(page.keys, statsMap, csrf, Date.now(), pagination, flash, total));
});

// 新增 Exa key（可附带 test call；name 可选，未填则自动生成）
exaAdmin.post("/add", async (c) => {
  const body = await c.req.parseBody();
  const key = ((body["key"] as string) ?? "").trim();
  let name = ((body["name"] as string) ?? "").trim();
  const doTest = body["test"] === "1";
  if (!key) return c.html(errorFragment("缺少 key"));
  if (!name) name = autoKeyName();
  const env = c.env;

  if (doTest) {
    try {
      const r = await fetch(EXA.base + EXA.capabilities.search!.path, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          authorization: `Bearer ${key}`,
        },
        body: JSON.stringify(EXA.testBody()),
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

  if (await keyValueExists(env, EXA.upstream, key)) {
    return c.html(errorFragment("该 key 已存在，未添加"));
  }

  await addUpstreamKey(env, EXA.upstream, key, name);
  await notifyKeyPoolSync(c.env, EXA.name).catch(() => {});
  return c.redirect("/admin/exa/list", 303);
});

// 批量添加 Exa keys（逗号或换行分隔；name 前缀可选，未填则自动生成）
exaAdmin.post("/add/batch", async (c) => {
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
    EXA.upstream,
    rawKeys.map((key, i) => ({
      key,
      name: namePrefix ? `${namePrefix}-${String(i + 1).padStart(pad, "0")}` : autoKeyName(),
    }))
  );
  let msg = `添加 ${res.added.length} 个`;
  if (res.duplicates.length)
    msg += `，跳过 ${res.duplicates.length} 个重复：第 ${res.duplicates.map((d) => d.index).join("、")} 行（${res.duplicates[0].maskedKey} 等已存在）`;
  await notifyKeyPoolSync(c.env, EXA.name).catch(() => {});
  return c.redirect(`/admin/exa/list?flash=${encodeURIComponent(msg)}`, 303);
});

exaAdmin.post("/:id/name", async (c) => {
  const id = c.req.param("id");
  const body = await c.req.parseBody();
  const name = (((body["name"] as string) ?? "").trim() || "未命名");
  const cur = await getUpstreamKey(c.env, EXA.upstream, id);
  if (!cur) return c.html(errorFragment("未找到该 key"));
  await updateUpstreamKey(c.env, EXA.upstream, id, { name });
  await notifyKeyPoolSync(c.env, EXA.name).catch(() => {});
  return c.redirect("/admin/exa/list", 303);
});

exaAdmin.post("/:id/toggle", async (c) => {
  const id = c.req.param("id");
  const cur = await getUpstreamKey(c.env, EXA.upstream, id);
  if (!cur) return c.html(errorFragment("未找到该 key"));
  const disabling = cur.status === "enabled";
  await updateUpstreamKey(c.env, EXA.upstream, id,
    disabling
      ? { status: "disabled" }
      : { status: "enabled", cooldown_until: null, suspended_cause: null });
  // 启用：先清内存冷却（reload 刻意保留内存冷却，故须显式 activate），再全量合并采纳 status。
  if (!disabling) await notifyKeyPoolActivate(c.env, EXA.name, id).catch(() => {});
  await notifyKeyPoolSync(c.env, EXA.name).catch(() => {});
  return c.redirect("/admin/exa/list", 303);
});

exaAdmin.post("/:id/delete", async (c) => {
  await deleteUpstreamKey(c.env, EXA.upstream, c.req.param("id"));
  await notifyKeyPoolSync(c.env, EXA.name).catch(() => {});
  return c.redirect("/admin/exa/list", 303);
});
