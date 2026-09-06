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
// 重试/选 key/上游传输（searchWithRetry 核）：见 src/retry.ts。

import { Context } from "hono";
import { Env, AppVariables } from "./types";
import { ProviderConfig } from "./providers";
import { PROVIDERS } from "./providers";
import {
  Capability,
  DistributedKey,
  Provider,
  WireProtocol,
  parseDistKey,
  hourKey,
} from "./domain";
import { getDistributedKey } from "./storage/dist-keys";
import { getUsageStore } from "./usage-store";
import { searchWithRetry, type CoreDeps } from "./retry";
import type { NativeTask, SearxngTask, ReaderTask, QueueTask } from "./queue-task";
import {
  parseSearxngParams,
  buildTavilyBody,
  resolveTopic,
  toSearxngResponse,
  searxngError,
} from "./adapters/searxng";
import {
  parseReaderTarget,
  parseDepth,
  buildExtractBody,
  toTextResponse,
  readerError,
} from "./adapters/reader";

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

// ---------------------------------------------------------------
// 队列任务执行器：主 Worker 鉴权后把"一次相对上游的请求"打成可序列化任务，转发给
// 所属 provider 的队列 DO；DO 串行放行（intervalMs 间隔），调用下方执行器跑完整
// 重试/冷却/统计。native / searxng / reader 各一个执行器，供 DO 引用（不依赖 Hono Context）。
// 任务 DTO 类型见 src/queue-task.ts；重试核见 src/retry.ts。
// ---------------------------------------------------------------

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
  // searxng 仅服务 Search 能力；search 是基础能力，必已落地
  const searchPath = def.capabilities.search!.path;
  return searchWithRetry(
    deps,
    def,
    apiKey,
    { path: searchPath, body: task.body, contentType: task.contentType },
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

/** reader 执行器（转换）：GET /reader/<url> → Tavily Extract 请求 → 转纯文本，交给通用重试核。 */
export async function runReaderTask(
  deps: CoreDeps,
  def: ProviderConfig,
  apiKey: string,
  task: ReaderTask
): Promise<Response> {
  // reader 仅服务 Extract 能力；extract 由 reader 前缀路由的 provider（tavily）必已落地
  const extractPath = def.capabilities.extract!.path;
  return searchWithRetry(
    deps,
    def,
    apiKey,
    {
      path: extractPath,
      body: JSON.stringify(buildExtractBody(task.url, task.depth)),
      contentType: "application/json",
    },
    {
      onSuccess: async (res) => {
        try {
          const raw = await res.json();
          return toTextResponse(raw, task.url);
        } catch {
          return null; // 2xx 但 JSON 解析失败：响应不可用，换 key 重试
        }
      },
      onFailure: async (outcome) => {
        // 目标在 failed_results（确定性失败）已由 toTextResponse 直接返回 502，不走到这里
        if (outcome.lastRes && !outcome.lastRes.ok) {
          return readerError(
            outcome.lastRes.status,
            `extract failed (${outcome.lastRes.status})`
          );
        }
        const msg =
          outcome.kind === "no-keys"
            ? "extract backend has no upstream keys configured"
            : outcome.kind === "exhausted"
              ? "extract upstream unreachable"
              : "extract backend temporarily unavailable";
        const status = outcome.kind === "exhausted" ? 502 : 503;
        return readerError(status, msg);
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

/** native 透传公共路径（native 执行器专属）：门禁读描述符结构（未声明能力→404；
 * 该能力未开放 native 或调用方协议不是 native → 405——其它协议走各自执行器
 * （/search 的 searxng 分支、/reader 的 reader 分支），不经此处）。
 * 命中则打 NativeTask{path=surface.path} 进队列 DO。供 /search(native) 与 /extract 复用。 */
async function runNative(
  c: Context<{ Bindings: Env; Variables: AppVariables }>,
  def: ProviderConfig,
  auth: { protocol: WireProtocol; provider: Provider; distKey: DistributedKey },
  capability: Capability
): Promise<Response> {
  const surface = def.capabilities[capability];
  if (!surface) {
    return def.errorBody(404, `${def.name} does not expose a /${capability} endpoint.`);
  }
  if (!surface.protocols.includes("native") || auth.protocol !== "native") {
    return def.errorBody(
      405,
      `"${capability}" is only supported with native credentials (Bearer ${auth.provider}-<key>).`
    );
  }
  const task: NativeTask = {
    kind: "native",
    path: surface.path,
    body: await c.req.text(),
    contentType: c.req.header("content-type") ?? "application/json",
  };
  return await forwardToQueue(c, def, auth.distKey.api_key, task);
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
        store.recordDistCall(apiKey, hour, "fail");
        store.flushSoon(c.executionCtx);
        return searxngError(error.status, error.message);
      }
      if (!parsed) {
        return searxngError(400, "invalid search parameters");
      }
      // D3：Tavily 无分页，pageno>1 返回合法的空结果响应（诚实、防重复），不耗上游配额
      if (parsed.pageno && parsed.pageno > 1) {
        const store = getUsageStore(c.env);
        store.recordDistCall(apiKey, hour, "success");
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

    // native 路径：复用 runNative（读 body → 门禁 → 转发队列 DO）
    return await runNative(c, def, authRes, "search");
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

/**
 * /extract 入口：Tavily Extract 的透明转发，仅支持 native 线协议（Bearer tavily-<key>）。
 * - extract 无 searxng 语义（searxng 是搜索协议转换），searxng 前缀在此确定性 405，不记统计。
 * - 门禁由描述符 `capabilities.extract` 结构判定：provider 未声明 → 404；声明但未开放该协议（searxng）→ 405，不记统计。
 * - 命中则复用 native 透传：任务打成 NativeTask{path=extract} 进队列 DO，走与 /search 完全相同的
 *   重试/熔断/用量统计链路（上游 key 成败 + 冷却 + 分发 key 调用计数自动落账）。
 * 前置门禁（405/404/401）不触达重试核 → 不计调用、不耗上游配额。
 */
export async function handleExtract(
  c: Context<{ Bindings: Env; Variables: AppVariables }>
): Promise<Response> {
  try {
    const authRes = await authenticate(c);
    if (!authRes) return c.res; // 错误响应已在 authenticate 写入

    const def = PROVIDERS[authRes.provider];
    // 门禁与 native 透传统一走 runNative：能力未声明→404、未开放该协议→405、命中→转发队列 DO
    return await runNative(c, def, authRes, "extract");
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return Response.json(
      { detail: { error: "Internal proxy error: " + msg } },
      { status: 502 }
    );
  }
}

/**
 * /reader 入口：URL→文本 的 reader 协议专属入口（后端 Tavily Extract，见 §适配）。
 * - reader 协议只服务 Extract 能力；非 reader 协议（native / searxng）打 /reader → 405。
 * - 目标 URL 从路径 `/reader/<url>` 抠出；目标自身含 query 时必须 percent-encode
 *   （否则 `?` 后的部分被当作外层请求的 query 吃掉）。
 * - 外层 query `?depth=basic|advanced` 透传 Tavily extract_depth（白名单，缺省 basic，非法 400）。
 * - 命中则打成 ReaderTask{kind=reader, url, depth} 进 tavily 队列 DO，走与 /search、/extract 相同的
 *   重试/熔断/用量统计链路；响应由 runReaderTask 转成 text/plain。
 * 前置门禁（405/400/401）不触达重试核 → 不计调用、不耗上游配额。
 */
export async function handleReader(
  c: Context<{ Bindings: Env; Variables: AppVariables }>
): Promise<Response> {
  try {
    const authRes = await authenticate(c);
    if (!authRes) return c.res; // 错误响应已在 authenticate 写入

    // /reader 只服务 reader 协议；native / searxng 打此端点 → 405
    if (authRes.protocol !== "reader") {
      return readerError(
        405,
        `"/reader" is only available with reader credentials (Bearer reader-tavily-<key>).`
      );
    }

    const target = parseReaderTarget(c.req.path);
    if (!target) {
      return readerError(400, "missing or malformed target URL: GET /reader/<url>");
    }

    // extract_depth 透传：只认 basic|advanced（advanced 是付费高档，非法值 400 拒收，不静默换代）
    const depth = parseDepth(c.req.query("depth"));
    if (!depth) {
      return readerError(400, `invalid "depth": expected "basic" or "advanced"`);
    }

    const def = PROVIDERS[authRes.provider]; // reader 前缀固定路由到 tavily
    const task: ReaderTask = { kind: "reader", url: target, depth };
    return await forwardToQueue(c, def, authRes.distKey.api_key, task);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return readerError(502, "internal reader error: " + msg);
  }
}
