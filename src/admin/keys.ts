// 分发 Keys 管理路由（provider 无关，共享）。挂载于 /admin/keys。

import { Hono } from "hono";
import { Env, AppVariables } from "../types";
import { getCsrfToken, validateCsrf } from "../auth";
import { DistStats, todayDate } from "../domain";
import {
  deleteDistributedKey,
  generateDistributedKey,
  listDistributedKeys,
  updateDistributedKey,
} from "../storage";
import { getUsageStore } from "../usage-store";
import {
  distGenerateResult,
  distListFragment,
  errorFragment,
  keysPage,
} from "../views";

export const keysAdmin = new Hono<{ Bindings: Env; Variables: AppVariables }>();

async function buildCallsMap(
  kv: KVNamespace,
  dkeys: { api_key: string }[],
  date: string
): Promise<Record<string, DistStats>> {
  const store = getUsageStore(kv);
  const callsMap: Record<string, DistStats> = {};
  await Promise.all(
    dkeys.map(async (k) => {
      callsMap[k.api_key] = await store.readDistCalls(k.api_key, date);
    })
  );
  return callsMap;
}

keysAdmin.get("/", async (c) => {
  const kv = c.env.KV;
  const csrf = (await getCsrfToken(c)) ?? "";
  const dkeys = await listDistributedKeys(kv);
  const callsMap = await buildCallsMap(kv, dkeys, todayDate());
  return c.html(keysPage(csrf, distListFragment(dkeys, callsMap, csrf)));
});

keysAdmin.get("/list", async (c) => {
  const kv = c.env.KV;
  const csrf = (await getCsrfToken(c)) ?? "";
  const dkeys = await listDistributedKeys(kv);
  const callsMap = await buildCallsMap(kv, dkeys, todayDate());
  return c.html(distListFragment(dkeys, callsMap, csrf));
});

// 生成新 key（明文只显示一次；请求时用 <provider>-<key> 前缀决定路由）
keysAdmin.post("/generate", async (c) => {
  if (!(await validateCsrf(c))) return c.html(errorFragment("CSRF 校验失败"), 403);
  const body = await c.req.parseBody();
  const note = ((body["note"] as string) ?? "").trim();
  if (!note) return c.html(errorFragment("备注必填"));
  const kv = c.env.KV;
  const generated = await generateDistributedKey(kv, note);
  const dkeys = await listDistributedKeys(kv);
  const callsMap = await buildCallsMap(kv, dkeys, todayDate());
  const csrf = (await getCsrfToken(c)) ?? "";
  return c.html(distGenerateResult(generated.api_key, dkeys, callsMap, csrf));
});

keysAdmin.post("/:apiKey/toggle", async (c) => {
  if (!(await validateCsrf(c))) return c.html(errorFragment("CSRF 校验失败"), 403);
  const apiKey = c.req.param("apiKey");
  const cur = (await listDistributedKeys(c.env.KV)).find((k) => k.api_key === apiKey);
  if (!cur) return c.html(errorFragment("未找到该 key"));
  await updateDistributedKey(c.env.KV, apiKey, {
    status: cur.status === "enabled" ? "disabled" : "enabled",
  });
  return c.redirect("/admin/keys/list", 303);
});

keysAdmin.post("/:apiKey/delete", async (c) => {
  if (!(await validateCsrf(c))) return c.html(errorFragment("CSRF 校验失败"), 403);
  await deleteDistributedKey(c.env.KV, c.req.param("apiKey"));
  return c.redirect("/admin/keys/list", 303);
});
