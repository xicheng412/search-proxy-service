// 分发 Keys 管理路由（provider 无关，共享）。挂载于 /admin/keys。

import { Hono } from "hono";
import { Env, AppVariables } from "../types";
import { getCsrfToken, validateCsrf } from "../auth";
import { DistStats, utcTodayStart } from "../domain";
import {
  deleteDistributedKey,
  generateDistributedKey,
  listDistributedKeys,
  updateDistributedKey,
} from "../storage";
import { getUsageStore } from "../usage-store";
import { resolvePublicBaseUrl } from "../config";
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
  const callsMap: Record<string, DistStats> = {};
  await Promise.all(
    dkeys.map(async (k) => {
      callsMap[k.api_key] = await store.readDistCalls(k.api_key, minHour);
    })
  );
  return callsMap;
}

keysAdmin.get("/", async (c) => {
  const env = c.env;
  const csrf = (await getCsrfToken(c)) ?? "";
  const base = resolvePublicBaseUrl(c.env);
  const dkeys = await listDistributedKeys(env);
  const callsMap = await buildCallsMap(env, dkeys, utcTodayStart());
  return c.html(keysPage(csrf, distListFragment(dkeys, callsMap, csrf, undefined, base)));
});

keysAdmin.get("/list", async (c) => {
  const env = c.env;
  const csrf = (await getCsrfToken(c)) ?? "";
  const base = resolvePublicBaseUrl(c.env);
  const dkeys = await listDistributedKeys(env);
  const callsMap = await buildCallsMap(env, dkeys, utcTodayStart());
  return c.html(distListFragment(dkeys, callsMap, csrf, undefined, base));
});

// 生成新 key（明文只显示一次；请求时用 <provider>-<key> 前缀决定路由）
keysAdmin.post("/generate", async (c) => {
  if (!(await validateCsrf(c))) return c.html(errorFragment("CSRF 校验失败"), 403);
  const body = await c.req.parseBody();
  const note = ((body["note"] as string) ?? "").trim();
  if (!note) return c.html(errorFragment("备注必填"));
  const env = c.env;
  const generated = await generateDistributedKey(env, note);
  const dkeys = await listDistributedKeys(env);
  const callsMap = await buildCallsMap(env, dkeys, utcTodayStart());
  const csrf = (await getCsrfToken(c)) ?? "";
  const base = resolvePublicBaseUrl(c.env);
  return c.html(distGenerateResult(generated.api_key, dkeys, callsMap, csrf, base));
});

keysAdmin.post("/:apiKey/toggle", async (c) => {
  if (!(await validateCsrf(c))) return c.html(errorFragment("CSRF 校验失败"), 403);
  const apiKey = c.req.param("apiKey");
  const cur = (await listDistributedKeys(c.env)).find((k) => k.api_key === apiKey);
  if (!cur) return c.html(errorFragment("未找到该 key"));
  await updateDistributedKey(c.env, apiKey, {
    status: cur.status === "enabled" ? "disabled" : "enabled",
  });
  return c.redirect("/admin/keys/list", 303);
});

keysAdmin.post("/:apiKey/delete", async (c) => {
  if (!(await validateCsrf(c))) return c.html(errorFragment("CSRF 校验失败"), 403);
  await deleteDistributedKey(c.env, c.req.param("apiKey"));
  return c.redirect("/admin/keys/list", 303);
});
