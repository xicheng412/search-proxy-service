// 分发 Keys 管理路由（provider 无关，共享）。挂载于 /admin/keys。

import { Hono } from "hono";
import { Env, AppVariables } from "../types";
import { getCsrfToken, validateCsrf } from "../auth";
import {
  DistStats,
  deleteDistributedKey,
  generateDistributedKey,
  getDistCalls,
  listDistributedKeys,
  todayDate,
  updateDistributedKey,
} from "../kv";
import {
  distGenerateResult,
  distListFragment,
  distViewForm,
  distViewPlain,
  errorFragment,
  keysPage,
} from "../views";

export const keysAdmin = new Hono<{ Bindings: Env; Variables: AppVariables }>();

async function buildCallsMap(
  kv: KVNamespace,
  dkeys: { api_key: string }[],
  date: string
): Promise<Record<string, DistStats>> {
  const callsMap: Record<string, DistStats> = {};
  await Promise.all(
    dkeys.map(async (k) => {
      callsMap[k.api_key] = await getDistCalls(kv, k.api_key, date);
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

// 查看明文（首查或二次密码确认）
keysAdmin.post("/:apiKey/view", async (c) => {
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
