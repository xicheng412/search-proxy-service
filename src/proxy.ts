// 透明代理层：把请求端对「本服务」的任意 Tavily 端点请求（/search、/extract、/map）
// 原样改造成对 Tavily 官方的请求 → 用真实 Tavily key 转发 → 拿到结果后原样透传回请求端。
//
// 语义：
//   请求端(分发 key, tvly-...)  ->  本服务(校验分发 key)  ->  Tavily 官方(真实 tvly- key)  ->  原样返回

import { Context } from "hono";
import { Env, AppVariables } from "./types";
import {
  getDistCalls,
  getDistributedKey,
  getTavilyStats,
  incrementDistCalls,
  incrementTavilyStats,
  listTavilyKeys,
  recordTavilyFailure,
  recordTavilySuccess,
  TavilyKey,
  todayDate,
} from "./kv";

const TAVILY_BASE = "https://api.tavily.com";

/**
 * 本服务对外暴露、并会透明转发到 Tavily 的端点。
 * 路径与 Tavily 官方一致（无版本前缀），保证只改 base_url 的工具能直接工作。
 */
export const TAVILY_ENDPOINTS = {
  search: "/search",
} as const;

/** 构造 Tavily 原生风格的错误体，让失败响应也贴近官方。 */
function tavilyError(status: number, message: string): Response {
  return Response.json({ detail: { error: message } }, { status });
}

/**
 * 加权随机：只从 status=enabled 且未冷却的 key 中选择；
 * 权重 = 1 / (当日失败数 + 1)，即失败越少权重越高（0 失败最高）。
 */
export function selectTavilyKey(
  keys: TavilyKey[],
  statsMap: Record<string, { success: number; fail: number }>,
  now: number = Date.now()
): TavilyKey | null {
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
export function selectDifferentTavilyKey(
  keys: TavilyKey[],
  statsMap: Record<string, { success: number; fail: number }>,
  excludeId: string,
  now: number = Date.now()
): TavilyKey | null {
  const others = keys.filter((k) => k.id !== excludeId);
  return selectTavilyKey(others, statsMap, now);
}

async function proxyToTavily(
  path: string,
  tavilyKey: string,
  body: string,
  contentType: string
): Promise<Response> {
  const headers: Record<string, string> = {
    authorization: `Bearer ${tavilyKey}`,
    "content-type": contentType || "application/json",
  };
  return fetch(TAVILY_BASE + path, {
    method: "POST",
    headers,
    body,
  });
}

/** 把 Tavily 的响应原样透传给请求端（重写响应头，去掉会泄漏信息/冲突的头）。 */
function passthrough(res: Response): Response {
  const newHeaders = new Headers(res.headers);
  return new Response(res.body, {
    status: res.status,
    statusText: res.statusText,
    headers: newHeaders,
  });
}

/**
 * 分类处理 Tavily 响应并更新统计，随后原样透传。
 * - 2xx：成功，记成功 + 重置熔断计数
 * - 429：由调用方决定是否切 key 重试（此函数直接透传，不计数）
 * - 其他（401/403/5xx/网络等）：记失败 + 熔断，并透传 Tavily 错误响应
 */
async function classifyAndHandle(
  kv: KVNamespace,
  usedKey: TavilyKey,
  res: Response
): Promise<Response> {
  const status = res.status;

  if (status >= 200 && status < 300) {
    await Promise.all([
      incrementTavilyStats(kv, usedKey.id, { success: 1 }).catch(() => {}),
      recordTavilySuccess(kv, usedKey.id).catch(() => {}),
    ]);
    return passthrough(res);
  }

  if (status === 429) {
    return passthrough(res);
  }

  await Promise.all([
    incrementTavilyStats(kv, usedKey.id, { fail: 1 }).catch(() => {}),
    recordTavilyFailure(kv, usedKey.id).catch(() => {}),
  ]);
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

/** 校验请求端分发 key，返回其 api_key；失败时返回 null 并已返回错误响应。 */
async function authenticate(
  c: Context<{ Bindings: Env; Variables: AppVariables }>
): Promise<string | null> {
  const auth = c.req.header("authorization") ?? "";
  // 大小写不敏感地识别 "Bearer ..." 前缀（容忍小写 bearer、多空格、以及可选的冒号），
  // 兼容不同 HTTP 客户端对 Authorization 头的各种写法。
  // 匹配后仅截取「scheme 之后、以空白分隔」的第一段作为 token。
  const token = parseBearer(auth);
  if (!token) {
    c.res = tavilyError(401, "Unauthorized: missing or invalid API key.");
    return null;
  }
  const distKey = await getDistributedKey(c.env.KV, token);
  if (!distKey || distKey.status !== "enabled") {
    c.res = tavilyError(401, "Unauthorized: missing or invalid API key.");
    return null;
  }
  return distKey.api_key;
}

/**
 * 透明的 Tavily 代理处理器：可与 /search、/extract、/map 等端点复用。
 * `path` 是 Tavily 官方路径（如 "/search"）。
 */
export async function handleTavilyProxy(
  c: Context<{ Bindings: Env; Variables: AppVariables }>,
  path: string
): Promise<Response> {
  // 1. 校验分发 key（请求端和本服务沟通，用的是后台生成的分发 key，tvly-... 前缀）
  const apiKey = await authenticate(c);
  if (!apiKey) return c.res;

  // 2. 增加分发 key 当日调用计数（尽力而为）
  const date = todayDate();
  await incrementDistCalls(c.env.KV, apiKey, date).catch(() => {});

  // 读取待转发请求体
  const originBody = await c.req.text();
  const contentType = c.req.header("content-type") ?? "application/json";

  // 3. 选出可用 Tavily key；无可用 -> 503（贴近 Tavily 报错格式）
  const kv = c.env.KV;
  const tkeys = await listTavilyKeys(kv);
  const statsMap: Record<string, { success: number; fail: number }> = {};
  await Promise.all(
    tkeys.map(async (k) => {
      statsMap[k.id] = await getTavilyStats(kv, k.id, date);
    })
  );

  const now = Date.now();
  const first = selectTavilyKey(tkeys, statsMap, now);
  if (!first) {
    return tavilyError(
      503,
      "No available upstream Tavily key (all disabled or in cooldown)."
    );
  }

  // 4. 用真实 Tavily key 透明转发首次请求
  const res = await proxyToTavily(path, first.key, originBody, contentType);

  // 5. 若首次 429：切换另一个可用 key 重试一次（仍是透明转发）
  if (res.status === 429) {
    const second = selectDifferentTavilyKey(tkeys, statsMap, first.id, now);
    if (second) {
      const retried = await proxyToTavily(path, second.key, originBody, contentType);
      if (retried.status === 429) {
        // 重试仍 429：两个 key 都计失败，透传 Tavily 错误响应
        await Promise.all([
          incrementTavilyStats(kv, first.id, { fail: 1 }).catch(() => {}),
          recordTavilyFailure(kv, first.id).catch(() => {}),
          incrementTavilyStats(kv, second.id, { fail: 1 }).catch(() => {}),
          recordTavilyFailure(kv, second.id).catch(() => {}),
        ]);
        return passthrough(retried);
      }
      return classifyAndHandle(kv, second, retried);
    }
    // 无第二个可选 key：首次 429 计失败，透传 Tavily 错误响应
    await Promise.all([
      incrementTavilyStats(kv, first.id, { fail: 1 }).catch(() => {}),
      recordTavilyFailure(kv, first.id).catch(() => {}),
    ]);
    return passthrough(res);
  }

  // 6. 非 429：按 2xx/401/403/5xx 分类处理并原样透传
  return classifyAndHandle(kv, first, res);
}

// 兼容旧调用：/search 透明代理（由 TAVILY_ENDPOINTS.search 驱动）
export async function handleSearch(
  c: Context<{ Bindings: Env; Variables: AppVariables }>
): Promise<Response> {
  try {
    return await handleTavilyProxy(c, TAVILY_ENDPOINTS.search);
  } catch (err) {
    // 透明代理不应裸抛 500；转为带错误信息的响应便于定位（也避免泄露堆栈给客户端）
    const msg = err instanceof Error ? err.message : String(err);
    return Response.json({ detail: { error: "Internal proxy error: " + msg } }, { status: 502 });
  }
}
