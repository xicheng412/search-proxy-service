// /reader 入口 handler：URL→文本 的 reader 协议专属入口（后端 Tavily Extract，见 §适配）。
// 鉴权已由路由层中间件完成（c.var.auth 保证在），本文件只做协议门禁 + 打装 ReaderTask。
// - reader 协议只服务 Extract 能力；非 reader 协议（native / searxng）打 /reader → 405。
// - 目标 URL 从路径 `/reader/<url>` 抠出；目标自身含 query 时必须 percent-encode
//   （否则 `?` 后的部分被当作外层请求的 query 吃掉）。
// - 外层 query `?depth=basic|advanced` 透传 Tavily extract_depth（白名单，缺省 basic，非法 400）。
// - 命中则打成 ReaderTask{kind=reader, url, depth} 进 tavily 队列 DO，走与 /search、/extract 相同的
//   重试/熔断/用量统计链路；响应由 runReaderTask 转成 text/plain。
// 前置门禁（405/400/401）不触达重试核 → 不计调用、不耗上游配额。

import { Context } from "hono";
import { Env, AppVariables } from "../../types";
import { PROVIDERS } from "../../providers";
import { forwardToQueue } from "../forward";
import {
  parseReaderTarget,
  parseDepth,
  readerError,
} from "../../adapters/reader";
import type { ReaderTask } from "../../queue/task";

type Ctx = Context<{ Bindings: Env; Variables: AppVariables }>;

export async function handleReader(c: Ctx): Promise<Response> {
  const auth = c.var.auth; // 中间件保证存在；错误响应已由 authenticate 短路
  try {
    // /reader 只服务 reader 协议；native / searxng 打此端点 → 405
    if (auth.protocol !== "reader") {
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

    const def = PROVIDERS[auth.provider]; // reader 前缀固定路由到 tavily
    const task: ReaderTask = { kind: "reader", url: target, depth };
    return await forwardToQueue(c, def, auth.distKey.api_key, task);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return readerError(502, "internal reader error: " + msg);
  }
}
