// 分发 Keys 管理路由（provider 无关，共享）。挂载于 /admin/keys。

import { Hono } from "hono";
import type { Context } from "hono";
import { Env, AppVariables } from "../types";
import { getCsrfToken } from "../auth";
import { DistStats, hourKey } from "../domain";
import {
  cachedDistributedKeyCount,
  deleteDistributedKey,
  DistributedKeyCursor,
  DistributedKeyPage,
  generateDistributedKey,
  getDistributedKey,
  listDistributedKeysPage,
  updateDistributedKey,
} from "../storage/dist-keys";
import { getUsageStore } from "../usage";
import { resolvePublicBaseUrl } from "../config";
import {
  PAGE_SIZE,
  PageCursor,
  PagePayload,
  buildPagination,
  buildSelfQuery,
  parsePageQuery,
} from "./pagination";
import type { Pagination } from "../views";
import {
  distGenerateResult,
  distListFragment,
  errorFragment,
  keysPage,
} from "../views";

export const keysAdmin = new Hono<{ Bindings: Env; Variables: AppVariables }>();

async function buildCallsMap(
  env: Env,
  dkeys: { api_key: string }[],
  minHour: string
): Promise<Record<string, DistStats>> {
  const store = getUsageStore(env);
  return store.readDistCallsByScopes(
    dkeys.map((k) => k.api_key),
    minHour
  );
}

// dist 游标 ↔ 共享分页游标（dist 的 id 即分发 api_key）。
const toPageCursor = (c: DistributedKeyCursor | null): PageCursor | null =>
  c ? { createdAt: c.createdAt, id: c.apiKey } : null;
const toDistCursor = (c: PageCursor | null): DistributedKeyCursor | null =>
  c ? { createdAt: c.createdAt, apiKey: c.id } : null;

type DistLoaded = {
  page: number;
  selfQuery: string;
  distPage: DistributedKeyPage;
  pagination: Pagination;
  total: number;
};

/** 解析当前页参数并读取对应 keyset 页；query 参数非法时返回 400，不访问 D1。 */
async function loadDistPage(
  c: Context<{ Bindings: Env; Variables: AppVariables }>
): Promise<Response | DistLoaded> {
  const q = parsePageQuery(c);
  if (!q.ok) return c.html(errorFragment(q.message), 400);
  let page: DistributedKeyPage;
  try {
    page = await listDistributedKeysPage(c.env, {
      after: toDistCursor(q.after),
      before: toDistCursor(q.before),
      limit: PAGE_SIZE,
    });
  } catch {
    return c.html(errorFragment("参数错误"), 400);
  }
  const payload: PagePayload = {
    hasPrevious: page.hasPrevious,
    hasNext: page.hasNext,
    previousCursor: toPageCursor(page.previousCursor),
    nextCursor: toPageCursor(page.nextCursor),
  };
  const pagination = buildPagination("/admin/keys", q.page, payload);
  const selfQuery = buildSelfQuery(q.page, q.after, q.before);
  const total = await cachedDistributedKeyCount(c.env);
  return { page: q.page, selfQuery, distPage: page, pagination, total };
}

keysAdmin.get("/", async (c) => {
  const loaded = await loadDistPage(c);
  if (loaded instanceof Response) return loaded;
  const { distPage, pagination, total, selfQuery } = loaded;
  const csrf = (await getCsrfToken(c)) ?? "";
  const base = resolvePublicBaseUrl(c.env);
  const callsMap = await buildCallsMap(
    c.env,
    distPage.keys,
    hourKey(Date.now() - 24 * 3600 * 1000)
  );
  return c.html(
    keysPage(
      csrf,
      distListFragment(distPage.keys, callsMap, csrf, pagination, undefined, base, total, selfQuery)
    )
  );
});

keysAdmin.get("/list", async (c) => {
  const loaded = await loadDistPage(c);
  if (loaded instanceof Response) return loaded;
  const { distPage, pagination, total, selfQuery } = loaded;
  const csrf = (await getCsrfToken(c)) ?? "";
  const base = resolvePublicBaseUrl(c.env);
  const callsMap = await buildCallsMap(
    c.env,
    distPage.keys,
    hourKey(Date.now() - 24 * 3600 * 1000)
  );
  return c.html(
    distListFragment(distPage.keys, callsMap, csrf, pagination, undefined, base, total, selfQuery)
  );
});

// 生成新 key（明文只显示一次；请求时用 <provider>-<key> 前缀决定路由）
keysAdmin.post("/generate", async (c) => {
  const body = await c.req.parseBody();
  const note = ((body["note"] as string) ?? "").trim();
  if (!note) return c.html(errorFragment("备注必填"));
  const nonce = ((body["nonce"] as string) ?? "").trim() || undefined;
  const env = c.env;
  const generated = await generateDistributedKey(env, note, undefined, nonce);
  // 新 key 按升序落在最末页；明文由 distGenerateResult 明文框展示，列表回第一页。
  const page1 = await listDistributedKeysPage(env, {
    after: null,
    before: null,
    limit: PAGE_SIZE,
  });
  const payload: PagePayload = {
    hasPrevious: page1.hasPrevious,
    hasNext: page1.hasNext,
    previousCursor: toPageCursor(page1.previousCursor),
    nextCursor: toPageCursor(page1.nextCursor),
  };
  const pagination1 = buildPagination("/admin/keys", 1, payload);
  const total = await cachedDistributedKeyCount(env);
  const csrf = (await getCsrfToken(c)) ?? "";
  const base = resolvePublicBaseUrl(c.env);
  const callsMap = await buildCallsMap(
    env,
    page1.keys,
    hourKey(Date.now() - 24 * 3600 * 1000)
  );
  return c.html(
    distGenerateResult(generated.api_key, page1.keys, callsMap, csrf, pagination1, base, total, "?page=1")
  );
});

keysAdmin.post("/:apiKey/toggle", async (c) => {
  const apiKey = c.req.param("apiKey");
  const body = await c.req.parseBody();
  const back = ((body["back"] as string) ?? "");
  const cur = await getDistributedKey(c.env, apiKey);
  if (!cur) return c.html(errorFragment("未找到该 key"));
  await updateDistributedKey(c.env, apiKey, {
    status: cur.status === "enabled" ? "disabled" : "enabled",
  });
  return c.redirect(
    "/admin/keys/list" + (back && back.startsWith("?") ? back : "?page=1"),
    303
  );
});

keysAdmin.post("/:apiKey/delete", async (c) => {
  const body = await c.req.parseBody();
  const back = ((body["back"] as string) ?? "");
  await deleteDistributedKey(c.env, c.req.param("apiKey"));
  return c.redirect(
    "/admin/keys/list" + (back && back.startsWith("?") ? back : "?page=1"),
    303
  );
});
