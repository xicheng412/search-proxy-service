// 数据面准入中间件：校验请求端分发 key（Bearer <[protocol-/]>provider-<key>）。
// 成功 → 注入 c.var.auth（AuthContext）；失败 → 直接写 c.res 并短路（后续 handler 不执行）。
// 由路由层 proxyApp 挂载在数据面端点前。原 src/proxy.ts 的 parseBearer + authenticate 逻辑原样搬迁。

import { MiddlewareHandler, Context } from "hono";
import { Env, AppVariables } from "../types";
import type { AuthContext } from "../types";
import { PROVIDERS } from "../providers";
import { getDistributedKey } from "../storage/dist-keys";
import { parseDistKey } from "../domain";
import { searxngError } from "../adapters/searxng";
import { readerError } from "../adapters/reader";

type Ctx = Context<{ Bindings: Env; Variables: AppVariables }>;

/**
 * 从 Authorization 头解析 Bearer token。
 * 大小写不敏感；兼容 "Bearer x"、"bearer x"、多空格、以及 "Bearer:x"。
 * 无合法 scheme 时返回空字符串。
 */
function parseBearer(auth: string): string {
  const m = /^bearer\s*:?\s+(.+)$/i.exec(auth.trim());
  if (!m) return "";
  return m[1].trim().split(/\s+/)[0];
}

/**
 * 校验请求端分发 key：Bearer 必须形如 `<[protocol-/]>provider-<key>`，前缀决定协议与路由。
 * 失败时返回 null 并已写入 c.res。
 * - 无 token / 前缀非法：无法得知 provider，用 Tavily 默认格式提示正确用法。
 * - 前缀合法但 key 无效/禁用：用该 provider 自己的报错格式。
 */
async function loadAuth(c: Ctx): Promise<AuthContext | null> {
  const token = parseBearer(c.req.header("authorization") ?? "");
  if (!token) {
    c.res = PROVIDERS.tavily.errorBody(401, "Unauthorized: missing API key.");
    return null;
  }
  const parsed = parseDistKey(token);
  if (!parsed) {
    c.res = PROVIDERS.tavily.errorBody(
      401,
      'Unauthorized: expect "Authorization: Bearer <tavily|exa|searxng-tavily|reader-tavily>-<key>".'
    );
    return null;
  }
  const distKey = await getDistributedKey(c.env, parsed.apiKey);
  if (!distKey || distKey.status !== "enabled") {
    // 错误体按线协议选择：native 用该 provider 官方格式；searxng/reader 用统一 `{error}` 格式
    c.res =
      parsed.protocol === "searxng"
        ? searxngError(401, "Unauthorized: missing or invalid API key.")
        : parsed.protocol === "reader"
          ? readerError(401, "Unauthorized: missing or invalid API key.")
          : PROVIDERS[parsed.provider].errorBody(
              401,
              "Unauthorized: missing or invalid API key."
            );
    return null;
  }
  return {
    protocol: parsed.protocol,
    provider: parsed.provider,
    apiKey: parsed.apiKey,
    distKey,
  };
}

/** 数据面准入：对通过者注入 c.var.auth 后放行；未通过者已写 c.res，直接短路。 */
export const authenticate: MiddlewareHandler<{
  Bindings: Env;
  Variables: AppVariables;
}> = async (c, next) => {
  const auth = await loadAuth(c);
  if (!auth) return; // 失败已写 c.res，短路
  c.set("auth", auth);
  await next();
};
