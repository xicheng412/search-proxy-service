// 分发 Keys 管理路由（provider 无关，共享）。挂载于 /admin/keys。

import { Hono } from "hono";
import { Env, AppVariables } from "../types";
import { getCsrfToken } from "../auth";
import { DistStats, hourKey } from "../domain";
import {
  deleteDistributedKey,
  generateDistributedKey,
  getDistributedKey,
  listDistributedKeys,
  updateDistributedKey,
} from "../storage/dist-keys";
import { getUsageStore } from "../usage";
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
  return store.readDistCallsByScopes(
    dkeys.map((k) => k.api_key),
    minHour
  );
}

keysAdmin.get("/", async (c) => {
  const env = c.env;
  const csrf = (await getCsrfToken(c)) ?? "";
  const base = resolvePublicBaseUrl(c.env);
  const dkeys = await listDistributedKeys(env);
  const callsMap = await buildCallsMap(env, dkeys, hourKey(Date.now() - 24 * 3600 * 1000));
  return c.html(keysPage(csrf, distListFragment(dkeys, callsMap, csrf, undefined, base)));
});

keysAdmin.get("/list", async (c) => {
  const env = c.env;
  const csrf = (await getCsrfToken(c)) ?? "";
  const base = resolvePublicBaseUrl(c.env);
  const dkeys = await listDistributedKeys(env);
  const callsMap = await buildCallsMap(env, dkeys, hourKey(Date.now() - 24 * 3600 * 1000));
  return c.html(distListFragment(dkeys, callsMap, csrf, undefined, base));
});

// 生成新 key（明文只显示一次；请求时用 <provider>-<key> 前缀决定路由）
keysAdmin.post("/generate", async (c) => {
  const body = await c.req.parseBody();
  const note = ((body["note"] as string) ?? "").trim();
  if (!note) return c.html(errorFragment("备注必填"));
  const nonce = ((body["nonce"] as string) ?? "").trim() || undefined;
  const env = c.env;
  const generated = await generateDistributedKey(env, note, undefined, nonce);
  const dkeys = await listDistributedKeys(env);
  const callsMap = await buildCallsMap(env, dkeys, hourKey(Date.now() - 24 * 3600 * 1000));
  const csrf = (await getCsrfToken(c)) ?? "";
  const base = resolvePublicBaseUrl(c.env);
  return c.html(distGenerateResult(generated.api_key, dkeys, callsMap, csrf, base));
});

keysAdmin.post("/:apiKey/toggle", async (c) => {
  const apiKey = c.req.param("apiKey");
  const cur = await getDistributedKey(c.env, apiKey);
  if (!cur) return c.html(errorFragment("未找到该 key"));
  await updateDistributedKey(c.env, apiKey, {
    status: cur.status === "enabled" ? "disabled" : "enabled",
  });
  return c.redirect("/admin/keys/list", 303);
});

keysAdmin.post("/:apiKey/delete", async (c) => {
  await deleteDistributedKey(c.env, c.req.param("apiKey"));
  return c.redirect("/admin/keys/list", 303);
});
