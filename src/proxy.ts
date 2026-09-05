// 代理编排层：请求端(分发 key) -> 本服务(校验分发 key) -> 上游(真实 key，按前缀路由) -> 返回。
// 本文件是 provider 无关的泛型算法：由 providers/*.ts 的描述符驱动，代码里无 tavily/exa 分支；
// 线协议差异（native 透传 vs searxng 转换）由调用方通过 RetryCallbacks 注入，核内无分支。
//
// 语义：
//   请求端(Bearer <[protocol-/]>provider-<key>)
//     -> 本服务(校验 key、按前缀选协议/路由 provider)
//     -> 上游官方(真实 key)
//     -> 按协议返回（native 原样透传 / searxng 转标准 JSON）
//
// 重试策略（searchWithRetry 核，一次请求最多尝试 MAX_ATTEMPTS 个不同上游 key）：
//   - 2xx        → 调用 onSuccess；返回 null 视为"成功但响应不可用"，按失败换 key 重试
//   - 429        → 换 key 重试，仅 post-use 冷却，不计熔断
//   - 400/404/422→ 客户端确定性错误：立即返回该响应，不重试、不记失败、不烧 key
//   - 401/403    → key 级错误：记统计失败（权重惩罚）+ 疑似失效长冷却（默认12h，可调），换 key
//   - 其余/网络  → 记录失败 + 指数退避冷却，换 key 重试
//   候选池耗尽或达到上限 → onFailure（透传最后一个错误响应，或 503/502）

import { Context } from "hono";
import { Env, AppVariables } from "./types";
import { ProviderConfig } from "./providers";
import { PROVIDERS } from "./providers";
import {
  CoreKey,
  DistributedKey,
  Provider,
  WireProtocol,
  parseDistKey,
  hourKey,
} from "./domain";
import { getDistributedKey, listUpstreamKeys } from "./storage";
import { getUsageStore } from "./usage-store";
import {
  recordUpstreamFailure,
  recordUpstreamSuccess,
  recordUpstreamRateLimit,
  recordUpstreamInvalid,
} from "./circuit-breaker";
import {
  parseSearxngParams,
  buildTavilyBody,
  resolveTopic,
  toSearxngResponse,
  searxngError,
  SearxngParams,
} from "./adapters/searxng";

/** 单次请求最多尝试的上游 key 数量。 */
const MAX_ATTEMPTS = 3;

/** 单次上游请求超时（网络无响应视为失败，换 key 重试）。 */
const UPSTREAM_TIMEOUT_MS = 30_000;

/** 队列 DO 执行所需的最小依赖（替代整颗 Hono Context）。 */
export interface CoreDeps {
  env: Env;
  executionCtx: { waitUntil(p: Promise<unknown>): void };
}

/** 通用重试的结果，交给 onFailure 按协议渲染最终响应。 */
export type RetryOutcome =
  | { kind: "success"; res: Response }
  | { kind: "no-keys"; lastRes: null } // 该 provider 未配置任何上游 key
  | { kind: "unavailable"; lastRes: null } // 全部冷却/禁用
  | { kind: "client-error"; lastRes: Response } // 4xx 客户端确定性错误
  | { kind: "exhausted"; lastRes: Response | null }; // 重试耗尽（可能全是网络异常，null）

export interface RetryCallbacks {
  /** 2xx 后的协议处理；返回 null 表示"成功但响应不可用"，核内按失败换 key 重试。 */
  onSuccess(res: Response): Promise<Response | null>;
  /** 最终失败渲染（含 503/502 语义），按协议决定透传或转换。 */
  onFailure(
    outcome: Exclude<RetryOutcome, { kind: "success" }>
  ): Promise<Response>;
}

/**
 * 加权随机：只从 status=enabled、未冷却 且 未被排除的 key 中选择；
 * 权重 = 1 / (该 key 今日失败数信号 + 1)，即失败越少权重越高（0 失败最高）。
 * statsMap 为空（单选候选时跳过统计）则退化为均匀权重。
 */
export function selectUpstreamKey(
  keys: CoreKey[],
  statsMap: Record<string, number>,
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
    const fail = statsMap[k.id] ?? 0;
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
    signal: AbortSignal.timeout(UPSTREAM_TIMEOUT_MS),
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
 * 校验请求端分发 key：Bearer 必须形如 `<[protocol-/]>provider-<key>`，前缀决定协议与路由。
 * 失败时返回 null 并已写入 c.res。
 * - 无 token / 前缀非法：无法得知 provider，用 Tavily 默认格式提示正确用法。
 * - 前缀合法但 key 无效/禁用：用该 provider 自己的报错格式。
 */
async function authenticate(
  c: Context<{ Bindings: Env; Variables: AppVariables }>
): Promise<{
  protocol: WireProtocol;
  provider: Provider;
  apiKey: string;
  distKey: DistributedKey;
} | null> {
  const token = parseBearer(c.req.header("authorization") ?? "");
  if (!token) {
    c.res = PROVIDERS.tavily.errorBody(401, "Unauthorized: missing API key.");
    return null;
  }
  const parsed = parseDistKey(token);
  if (!parsed) {
    c.res = PROVIDERS.tavily.errorBody(
      401,
      'Unauthorized: expect "Authorization: Bearer <tavily|exa|searxng-tavily>-<key>".'
    );
    return null;
  }
  const distKey = await getDistributedKey(c.env, parsed.apiKey);
  if (!distKey || distKey.status !== "enabled") {
    // 错误体按线协议选择：native 用该 provider 官方格式；searxng 用官方 `{error}` 格式
    c.res =
      parsed.protocol === "searxng"
        ? searxngError(401, "Unauthorized: missing or invalid API key.")
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

/**
 * 通用重试核：鉴权后由各协议路径共用。签名与请求方 Context 解耦——只依赖 env 与
 * waitUntil，因此队列 DO（无 Hono Context）也能直接调用。
 * - 每次尝试选不同 key；命中"不可重试"分类提前返回，避免浪费配额/流量。
 * - 无 key 配置 / 全部冷却禁用 → 503（经 onFailure 渲染）。
 */
export async function searchWithRetry(
  deps: CoreDeps,
  def: ProviderConfig,
  apiKey: string,
  request: { path: string; body: string; contentType: string },
  cb: RetryCallbacks
): Promise<Response> {
  const store = getUsageStore(deps.env);
  const env = deps.env;

  // 1. 增加分发 key 调用计数（按 provider + 结果拆分，进内存缓冲，尽力而为）
  const hour = hourKey();
  store.recordDistCall(apiKey, def.name, hour, "success");
  // 节流触发统计 flush（退避到 waitUntil，约每 5s 最多一次；不阻塞本请求）
  store.flushSoon(deps.executionCtx);

  // 2. 选出该 provider 的上游 key；未配置任何 key -> 503
  const keys = await listUpstreamKeys(env, def.upstream);
  if (keys.length === 0) {
    return cb.onFailure({ kind: "no-keys", lastRes: null });
  }

  // 3. 候选预检：全部冷却/禁用 -> 503；仅候选 ≥2 才读权重信号（内存信号，0 次 D1 往返）
  const now0 = Date.now();
  const candidates = keys.filter(
    (k) =>
      k.status === "enabled" &&
      (k.cooldown_until == null || k.cooldown_until <= now0)
  );
  if (candidates.length === 0) {
    return cb.onFailure({ kind: "unavailable", lastRes: null });
  }
  const statsMap =
    candidates.length < 2 ? {} : await store.readUpstreamWeightSignal(candidates.map((k) => k.id));

  const tried = new Set<string>();
  let lastRes: Response | null = null;

  // 4. 重试循环：最多 MAX_ATTEMPTS 次，每次选不同的 key
  for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt++) {
    const now = Date.now();
    const key = selectUpstreamKey(keys, statsMap, now, tried);
    if (!key) break; // 候选池耗尽
    tried.add(key.id);

    // 发起上游请求（fetch 可能抛出网络异常/超时）
    let res: Response;
    try {
      res = await proxyToUpstream(def, request.path, key.key, request.body, request.contentType);
    } catch {
      // 网络异常/超时：视为失败，换 key 重试
      store.recordUpstreamResult(key.id, def.name, hour, "fail");
      await recordUpstreamFailure(env, def.upstream, key.id, now).catch(() => {});
      continue;
    }

    // 2xx 成功 → 交给 onSuccess；返回 null 表示响应不可用，按失败换 key
    if (res.ok) {
      const out = await cb.onSuccess(res);
      if (out) {
        store.recordUpstreamResult(key.id, def.name, hour, "success");
        await recordUpstreamSuccess(env, def.upstream, key.id, now).catch(() => {});
        return out;
      }
      lastRes = res;
      store.recordUpstreamResult(key.id, def.name, hour, "fail");
      await recordUpstreamFailure(env, def.upstream, key.id, now).catch(() => {});
      continue;
    }

    lastRes = res;

    // 429 限流 → 换 key 重试，仅 post-use 冷却
    if (res.status === 429) {
      await recordUpstreamRateLimit(env, def.upstream, key.id, now).catch(() => {});
      continue;
    }

    // 400/404/422 客户端确定性错误 → 立即返回该响应（不重试、不记失败、不烧 key）
    if (res.status === 400 || res.status === 404 || res.status === 422) {
      return cb.onFailure({ kind: "client-error", lastRes: res });
    }

    // 401/403 key 级错误 → 记统计失败（权重惩罚）+ 疑似失效长冷却（默认12h），换 key
    if (res.status === 401 || res.status === 403) {
      store.recordUpstreamResult(key.id, def.name, hour, "fail");
      await recordUpstreamInvalid(env, def.upstream, key.id, now).catch(() => {});
      continue;
    }

    // 其余（5xx / 未知状态）→ 记录失败 + 指数退避冷却，换 key 重试
    store.recordUpstreamResult(key.id, def.name, hour, "fail");
    await recordUpstreamFailure(env, def.upstream, key.id, now).catch(() => {});
  }

  // 5. 重试耗尽 → onFailure（透传最后错误响应，或 503/502）
  return cb.onFailure({ kind: "exhausted", lastRes });
}

// ---------------------------------------------------------------
// 队列任务：主 Worker 鉴权后把"一次相对上游的请求"打成可序列化任务，转发给
// 所属 provider 的队列 DO；DO 串行放行（intervalMs 间隔），调用下方执行器跑完整
// 重试/冷却/统计。native 与 searxng 各一个执行器，供 DO 引用（不依赖 Hono Context）。
// ---------------------------------------------------------------
export interface NativeTask {
  kind: "native";
  path: string;
  body: string;
  contentType: string;
}
export interface SearxngTask {
  kind: "searxng";
  query: string;
  topic?: "news" | "general";
  body: string;
  contentType: string;
}
export type QueueTask = NativeTask | SearxngTask;

/** native 执行器（透传）：构建 passthrough 回调，交给通用重试核。 */
export async function runNativeTask(
  deps: CoreDeps,
  def: ProviderConfig,
  apiKey: string,
  task: NativeTask
): Promise<Response> {
  return searchWithRetry(
    deps,
    def,
    apiKey,
    { path: task.path, body: task.body, contentType: task.contentType },
    {
      onSuccess: async (_res) => passthrough(_res),
      onFailure: async (outcome) => {
        if (outcome.lastRes) return passthrough(outcome.lastRes);
        if (outcome.kind === "no-keys") {
          return def.errorBody(503, `No ${def.name} upstream keys configured.`);
        }
        if (outcome.kind === "exhausted") {
          // 全部网络异常、无任何响应可得 → 502（与原实现及文档 §6.3 一致）
          return def.errorBody(
            502,
            `All upstream ${def.name} keys failed after retries.`
          );
        }
        return def.errorBody(
          503,
          `All upstream ${def.name} keys are temporarily unavailable (disabled or in cooldown).`
        );
      },
    }
  );
}

/** searxng 执行器（转换）：构建 searxng 转换回调，交给通用重试核。 */
export async function runSearxngTask(
  deps: CoreDeps,
  def: ProviderConfig,
  apiKey: string,
  task: SearxngTask
): Promise<Response> {
  return searchWithRetry(
    deps,
    def,
    apiKey,
    { path: def.endpoints.search, body: task.body, contentType: task.contentType },
    {
      onSuccess: async (res) => {
        try {
          const raw = await res.json();
          const converted = toSearxngResponse(raw, task.query, task.topic);
          return new Response(JSON.stringify(converted), {
            status: res.status,
            headers: { "content-type": "application/json" },
          });
        } catch {
          // 2xx 但 JSON 解析/转换失败：响应不可用，换 key 重试
          return null;
        }
      },
      onFailure: async (outcome) => {
        // 2xx 但内容不可用（如解析失败）时 lastRes 是 200 —— 视为上游故障，不返回 200+error
        if (outcome.lastRes && !outcome.lastRes.ok) {
          return searxngError(
            outcome.lastRes.status,
            `search failed (${outcome.lastRes.status})`
          );
        }
        const msg =
          outcome.kind === "no-keys"
            ? "search backend has no upstream keys configured"
            : outcome.kind === "exhausted"
              ? "search upstream unreachable"
              : "search backend temporarily unavailable";
        const status = outcome.kind === "exhausted" ? 502 : 503;
        return searxngError(status, msg);
      },
    }
  );
}

/** 把任务转发给所属 provider 的队列 DO，返回 DO 最终响应（持连接等待其时间片）。 */
async function forwardToQueue(
  c: Context<{ Bindings: Env; Variables: AppVariables }>,
  def: ProviderConfig,
  apiKey: string,
  task: QueueTask
): Promise<Response> {
  const id = c.env.QUEUE.idFromName(def.name);
  const stub = c.env.QUEUE.get(id);
  return stub.fetch("https://queue.internal/", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ provider: def.name, apiKey, task }),
    signal: c.req.raw.signal,
  });
}

/** 把搜索请求参数归一化成 kv（GET → query string；POST → 表单/JSON 字段）。 */
async function collectSearxngParams(
  c: Context<{ Bindings: Env; Variables: AppVariables }>
): Promise<Record<string, string>> {
  const kv: Record<string, string> = {};
  if (c.req.method === "GET") {
    const url = new URL(c.req.url);
    url.searchParams.forEach((v, k) => {
      kv[k] = v;
    });
    return kv;
  }
  const body = await c.req.parseBody();
  for (const [k, v] of Object.entries(body)) {
    if (typeof v === "string") kv[k] = v;
  }
  return kv;
}

/** /search 入口：鉴权分发 key，把任务打成可序列化载荷转发给队列 DO。 */
export async function handleSearch(
  c: Context<{ Bindings: Env; Variables: AppVariables }>
): Promise<Response> {
  // 先解析 token 拿线协议（纯解析、不查库），供鉴权失败/异常时按协议渲染错误体。
  let protocol: WireProtocol = "native";
  const token = parseBearer(c.req.header("authorization") ?? "");
  if (token) {
    const parsed = parseDistKey(token);
    if (parsed) protocol = parsed.protocol;
  }
  try {
    const authRes = await authenticate(c);
    if (!authRes) return c.res; // 错误响应已在 authenticate 写入
    const def = PROVIDERS[authRes.provider];
    const apiKey = authRes.distKey.api_key;
    const hour = hourKey();

    if (authRes.protocol === "searxng") {
      const params = await collectSearxngParams(c);
      const { params: parsed, error } = parseSearxngParams(params);
      if (error) {
        // 参数错误也记一次调用（结果记 fail）
        const store = getUsageStore(c.env);
        store.recordDistCall(apiKey, def.name, hour, "fail");
        store.flushSoon(c.executionCtx);
        return searxngError(error.status, error.message);
      }
      if (!parsed) {
        return searxngError(400, "invalid search parameters");
      }
      // D3：Tavily 无分页，pageno>1 返回合法的空结果响应（诚实、防重复），不耗上游配额
      if (parsed.pageno && parsed.pageno > 1) {
        const store = getUsageStore(c.env);
        store.recordDistCall(apiKey, def.name, hour, "success");
        store.flushSoon(c.executionCtx);
        const empty = toSearxngResponse(
          { results: [] },
          parsed.query,
          resolveTopic(parsed) ?? undefined
        );
        return new Response(JSON.stringify(empty), {
          status: 200,
          headers: { "content-type": "application/json" },
        });
      }
      const task: SearxngTask = {
        kind: "searxng",
        query: parsed.query,
        topic: resolveTopic(parsed) ?? undefined,
        body: JSON.stringify(buildTavilyBody(parsed)),
        contentType: "application/json",
      };
      return await forwardToQueue(c, def, apiKey, task);
    }

    // native 路径：读一次 body 固定，转发给队列 DO
    const task: NativeTask = {
      kind: "native",
      path: def.endpoints.search,
      body: await c.req.text(),
      contentType: c.req.header("content-type") ?? "application/json",
    };
    return await forwardToQueue(c, def, apiKey, task);
  } catch (err) {
    // 代理不应裸抛 500；转为带错误信息的响应便于定位（也避免泄露堆栈给客户端）
    const msg = err instanceof Error ? err.message : String(err);
    if (protocol === "searxng") {
      return searxngError(502, "internal search error");
    }
    return Response.json(
      { detail: { error: "Internal proxy error: " + msg } },
      { status: 502 }
    );
  }
}
