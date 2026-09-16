// /search 入口 handler：鉴权已由路由层中间件完成（c.var.auth 保证在），本文件只做
// 任务打装与转发——searxng 分支（参数归一化+校验+打装 SearxngTask）与 native 分支（runNative 透传）。
// 原 src/proxy.ts 的 handleSearch / collectSearxngParams 搬迁，随中间件化的契约调整。

import { Context } from "hono";
import { Env, AppVariables } from "../../types";
import { PROVIDERS } from "../../providers";
import { hourKey } from "../../domain";
import { getUsageStore } from "../../usage";
import { forwardToQueue, runNative } from "../forward";
import {
  parseSearxngParams,
  resolveTopic,
  buildTavilyBody,
  toSearxngResponse,
  searxngError,
} from "../../adapters/searxng";
import type { SearxngTask } from "../../queue/task";

type Ctx = Context<{ Bindings: Env; Variables: AppVariables }>;

/** 把搜索请求参数归一化成 kv（GET → query string；POST → 表单/JSON 字段）。 */
async function collectSearxngParams(c: Ctx): Promise<Record<string, string>> {
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

/** /search 入口：鉴权分发 key（中间件已注入 c.var.auth），把任务打成可序列化载荷转发给队列 DO。 */
export async function handleSearch(c: Ctx): Promise<Response> {
  const auth = c.var.auth; // 中间件保证存在；错误响应已由 authenticate 短路
  const def = PROVIDERS[auth.provider];
  const apiKey = auth.distKey.api_key;
  const hour = hourKey();

  try {
    if (auth.protocol === "searxng") {
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
    return await runNative(c, def, auth, "search");
  } catch (err) {
    // 代理不应裸抛 500；转为带错误信息的响应便于定位（也避免泄露堆栈给客户端）
    const msg = err instanceof Error ? err.message : String(err);
    if (auth.protocol === "searxng") {
      return searxngError(502, "internal search error");
    }
    return Response.json(
      { detail: { error: "Internal proxy error: " + msg } },
      { status: 502 }
    );
  }
}
