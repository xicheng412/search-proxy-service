// 透明代理层：请求端(分发 key) -> 本服务(校验分发 key) -> 上游(真实 key，按请求前缀的 provider 路由) -> 原样返回。
// 本文件是 provider 无关的泛型算法：由 providers/*.ts 的描述符驱动，代码里无 tavily/exa 分支。
//
// 语义：
//   请求端(Bearer <provider>-<key>)  ->  本服务(校验 key、按 <provider> 前缀路由)  ->  上游官方(真实 key)  ->  原样返回

import { Context } from "hono";
import { Env, AppVariables } from "./types";
import { ProviderConfig } from "./providers";
import { PROVIDERS } from "./providers";
import {
  CoreKey,
  DistAuth,
  DistributedKey,
  Provider,
  parseDistKey,
  todayDate,
} from "./domain";
import { getDistributedKey, listUpstreamKeys } from "./storage";
import { getUsageStore } from "./usage-store";
import { recordUpstreamFailure, recordUpstreamSuccess } from "./circuit-breaker";

/**
 * 加权随机：只从 status=enabled 且未冷却的 key 中选择；
 * 权重 = 1 / (当日失败数 + 1)，即失败越少权重越高（0 失败最高）。
 */
export function selectUpstreamKey(
  keys: CoreKey[],
  statsMap: Record<string, { success: number; fail: number }>,
  now: number = Date.now()
): CoreKey | null {
  const candidates = keys.filter(
    (k) =>
      k.status === "enabled" &&
      (k.cooldown_until == null || k.cooldown_until <= now)
  );
  if (candidates.length === 0) return null;

  const weights = candidates.map((k) => {
    const fail = statsMap[k.id]?.fail ?? 0;
    return 1 / (fail + 1);
  });
  const total = weights.reduce((a, b) => a + b, 0);
  let r = Math.random() * total;
  for (let i = 0; i < candidates.length; i++) {
    r -= weights[i];
    if (r <= 0) return candidates[i];
  }
  return candidates[candidates.length - 1];
}

/** 选出与指定 key 不同的另一个可用 key（用于 429 重试）。 */
export function selectDifferentUpstreamKey(
  keys: CoreKey[],
  statsMap: Record<string, { success: number; fail: number }>,
  excludeId: string,
  now: number = Date.now()
): CoreKey | null {
  const others = keys.filter((k) => k.id !== excludeId);
  return selectUpstreamKey(others, statsMap, now);
}

async function proxyToUpstream(
  def: ProviderConfig,
  path: string,
  upstreamKey: string,
  body: string,
  contentType: string
): Promise<Response> {
  const headers: Record<string, string> = {
    authorization: `Bearer ${upstreamKey}`,
    "content-type": contentType || "application/json",
  };
  return fetch(def.base + path, {
    method: "POST",
    headers,
    body,
  });
}

/** 把上游的响应原样透传给请求端（重写响应头，去掉会泄漏信息/冲突的头）。 */
function passthrough(res: Response): Response {
  const newHeaders = new Headers(res.headers);
  return new Response(res.body, {
    status: res.status,
    statusText: res.statusText,
    headers: newHeaders,
  });
}

/**
 * 分类处理上游响应并更新统计，随后原样透传。
 * - 2xx：成功，记成功 + 重置熔断计数
 * - 429：由调用方决定是否切 key 重试（此函数直接透传，不计数）
 * - 其他（401/403/5xx/网络等）：记失败 + 熔断，并透传上游错误响应
 */
async function classifyAndHandle(
  kv: KVNamespace,
  def: ProviderConfig,
  usedKey: CoreKey,
  res: Response
): Promise<Response> {
  const store = getUsageStore(kv);
  const date = todayDate();
  const status = res.status;

  if (status >= 200 && status < 300) {
    store.recordUpstreamResult(usedKey.id, "success", date);
    await recordUpstreamSuccess(kv, usedKey.id).catch(() => {});
    return passthrough(res);
  }

  if (status === 429) {
    return passthrough(res);
  }

  store.recordUpstreamResult(usedKey.id, "fail", date);
  await recordUpstreamFailure(kv, def.upstream, usedKey.id).catch(() => {});
  return passthrough(res);
}

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
 * 校验请求端分发 key：Bearer 必须形如 `<provider>-<key>`，前缀决定路由。
 * 失败时返回 null 并已写入 c.res。
 * - 无 token / 前缀非法：无法得知 provider，用 Tavily 默认格式提示正确用法。
 * - 前缀合法但 key 无效/禁用：用该 provider 自己的报错格式。
 */
async function authenticate(
  c: Context<{ Bindings: Env; Variables: AppVariables }>
): Promise<{ provider: Provider; apiKey: string; distKey: DistributedKey } | null> {
  const token = parseBearer(c.req.header("authorization") ?? "");
  if (!token) {
    c.res = PROVIDERS.tavily.errorBody(401, "Unauthorized: missing API key.");
    return null;
  }
  const parsed = parseDistKey(token);
  if (!parsed) {
    c.res = PROVIDERS.tavily.errorBody(
      401,
      'Unauthorized: expect "Authorization: Bearer <tavily|exa>-<key>".'
    );
    return null;
  }
  const distKey = await getDistributedKey(c.env.KV, parsed.apiKey);
  if (!distKey || distKey.status !== "enabled") {
    c.res = PROVIDERS[parsed.provider].errorBody(
      401,
      "Unauthorized: missing or invalid API key."
    );
    return null;
  }
  return { provider: parsed.provider, apiKey: parsed.apiKey, distKey };
}

/**
 * 透明的上游代理处理器：与请求前缀对应的 provider 通信。
 * `def` 来自 PROVIDERS[provider]，`path` 是上游官方路径（如 "/search"）。
 * 调用前分发 key 已鉴权。
 */
export async function handleProviderProxy(
  c: Context<{ Bindings: Env; Variables: AppVariables }>,
  def: ProviderConfig,
  path: string,
  apiKey: string
): Promise<Response> {
  const store = getUsageStore(c.env.KV);
  const kv = c.env.KV;

  // 1. 增加分发 key 当日调用计数（按 provider 拆分，进内存缓冲，尽力而为）
  const date = todayDate();
  store.recordDistCall(apiKey, def.name, date);
  // 节流触发统计 flush（退避到 waitUntil，约每 5s 最多一次；不阻塞本请求）
  store.flushSoon(c.executionCtx);

  // 读取待转发请求体
  const originBody = await c.req.text();
  const contentType = c.req.header("content-type") ?? "application/json";

  // 2. 选出该 provider 的可用上游 key；无可用 -> 503（贴近该 provider 报错格式）
  const keys = await listUpstreamKeys(kv, def.upstream);
  // 权重读：一次取全部 key（KV 值缓存 30s + 本 isolate 未 flush 增量叠加上去）
  const statsMap = await store.readUpstreamTodayStats(keys.map((k) => k.id), date);

  const now = Date.now();
  const first = selectUpstreamKey(keys, statsMap, now);
  if (!first) {
    return def.errorBody(
      503,
      `No available upstream ${def.name} key (all disabled or in cooldown).`
    );
  }

  // 3. 用真实上游 key 透明转发首次请求
  const res = await proxyToUpstream(def, path, first.key, originBody, contentType);

  // 4. 若首次 429：切换另一个可用 key 重试一次（仍是透明转发）
  if (res.status === 429) {
    const second = selectDifferentUpstreamKey(keys, statsMap, first.id, now);
    if (second) {
      const retried = await proxyToUpstream(def, path, second.key, originBody, contentType);
      if (retried.status === 429) {
        // 重试仍 429：两个 key 都计失败，透传上游错误响应
        store.recordUpstreamResult(first.id, "fail", date);
        await recordUpstreamFailure(kv, def.upstream, first.id).catch(() => {});
        store.recordUpstreamResult(second.id, "fail", date);
        await recordUpstreamFailure(kv, def.upstream, second.id).catch(() => {});
        return passthrough(retried);
      }
      return classifyAndHandle(kv, def, second, retried);
    }
    // 无第二个可选 key：首次 429 计失败，透传上游错误响应
    store.recordUpstreamResult(first.id, "fail", date);
    await recordUpstreamFailure(kv, def.upstream, first.id).catch(() => {});
    return passthrough(res);
  }

  // 5. 非 429：按 2xx/401/403/5xx 分类处理并原样透传
  return classifyAndHandle(kv, def, first, res);
}

/** /search 透明代理入口：鉴权分发 key，按请求前缀的 provider 路由到对应上游。 */
export async function handleSearch(
  c: Context<{ Bindings: Env; Variables: AppVariables }>
): Promise<Response> {
  try {
    const authRes = await authenticate(c);
    if (!authRes) return c.res; // 错误响应已在 authenticate 写入
    const def = PROVIDERS[authRes.provider];
    return await handleProviderProxy(
      c,
      def,
      def.endpoints.search,
      authRes.distKey.api_key
    );
  } catch (err) {
    // 透明代理不应裸抛 500；转为带错误信息的响应便于定位（也避免泄露堆栈给客户端）
    const msg = err instanceof Error ? err.message : String(err);
    return Response.json(
      { detail: { error: "Internal proxy error: " + msg } },
      { status: 502 }
    );
  }
}
