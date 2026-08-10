// 透明代理层：请求端(分发 key) -> 本服务(校验分发 key) -> 上游(真实 key，按请求前缀的 provider 路由) -> 原样返回。
// 本文件是 provider 无关的泛型算法：由 providers/*.ts 的描述符驱动，代码里无 tavily/exa 分支。
//
// 语义：
//   请求端(Bearer <provider>-<key>)  ->  本服务(校验 key、按 <provider> 前缀路由)  ->  上游官方(真实 key)  ->  原样返回
//
// 重试策略：
//   一次请求最多尝试 3 个不同的上游 key（MAX_ATTEMPTS）。
//   每次失败后换 key 重试，失败 key 会进入冷却（post-use 5s + 指数退避），
//   重试过程中被冷却/禁用的 key 自动被 selectUpstreamKey 过滤，不会再次选中。

import { Context } from "hono";
import { Env, AppVariables } from "./types";
import { ProviderConfig } from "./providers";
import { PROVIDERS } from "./providers";
import {
  CoreKey,
  DistributedKey,
  Provider,
  parseDistKey,
  todayDate,
} from "./domain";
import { getDistributedKey, listUpstreamKeys } from "./storage";
import { getUsageStore } from "./usage-store";
import {
  recordUpstreamFailure,
  recordUpstreamSuccess,
  recordUpstreamRateLimit,
} from "./circuit-breaker";

/** 单次请求最多尝试的上游 key 数量。 */
const MAX_ATTEMPTS = 3;

/**
 * 加权随机：只从 status=enabled、未冷却 且 未被排除的 key 中选择；
 * 权重 = 1 / (当日失败数 + 1)，即失败越少权重越高（0 失败最高）。
 */
export function selectUpstreamKey(
  keys: CoreKey[],
  statsMap: Record<string, { success: number; fail: number }>,
  now: number = Date.now(),
  excludeIds?: Set<string>
): CoreKey | null {
  const candidates = keys.filter(
    (k) =>
      k.status === "enabled" &&
      (k.cooldown_until == null || k.cooldown_until <= now) &&
      (!excludeIds || !excludeIds.has(k.id))
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
 *
 * 重试策略：最多尝试 MAX_ATTEMPTS 个不同的上游 key。
 * - 2xx → 立即返回，记录成功并重置连续失败
 * - 429 → 换 key 重试，仅 post-use 冷却，不计熔断
 * - 其他错误 / 网络异常 → 换 key 重试，记录失败 + 指数退避冷却
 * - 候选池耗尽或达到上限 → 透传最后一个错误响应
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

  // 2. 选出该 provider 的可用上游 key；无可用 -> 503
  const keys = await listUpstreamKeys(kv, def.upstream);
  const statsMap = await store.readUpstreamTodayStats(
    keys.map((k) => k.id),
    date
  );

  const tried = new Set<string>();
  let lastRes: Response | null = null;

  // 3. 重试循环：最多 MAX_ATTEMPTS 次，每次选不同的 key
  for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt++) {
    const now = Date.now();
    const key = selectUpstreamKey(keys, statsMap, now, tried);
    if (!key) break; // 候选池耗尽
    tried.add(key.id);

    // 发起上游请求（fetch 可能抛出网络异常）
    let res: Response;
    try {
      res = await proxyToUpstream(def, path, key.key, originBody, contentType);
    } catch {
      // 网络异常：视为失败，换 key 重试
      store.recordUpstreamResult(key.id, "fail", date);
      await recordUpstreamFailure(kv, def.upstream, key.id, now).catch(() => {});
      continue;
    }

    // 2xx 成功 → 立即返回
    if (res.ok) {
      store.recordUpstreamResult(key.id, "success", date);
      await recordUpstreamSuccess(kv, def.upstream, key.id, now).catch(() => {});
      return passthrough(res);
    }

    lastRes = res;

    // 429 限流 → 换 key 重试，仅 post-use 冷却
    if (res.status === 429) {
      await recordUpstreamRateLimit(kv, def.upstream, key.id, now).catch(() => {});
      continue;
    }

    // 401 / 403 / 5xx 等 → 换 key 重试，记录失败 + 指数退避冷却
    store.recordUpstreamResult(key.id, "fail", date);
    await recordUpstreamFailure(kv, def.upstream, key.id, now).catch(() => {});
  }

  // 4. 重试耗尽：透传最后一个错误响应，或返回 502
  if (lastRes) return passthrough(lastRes);
  return def.errorBody(
    502,
    `All upstream ${def.name} keys exhausted or failed after retries.`
  );
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
