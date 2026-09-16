// /extract 入口 handler：Tavily Extract 的透明转发，仅支持 native 线协议（Bearer tavily-<key>）。
// 鉴权已由路由层中间件完成（c.var.auth 保证在），本文件只做 native 透传转发。
// - extract 无 searxng 语义（searxng 是搜索协议转换），searxng 前缀在此确定性 405，不记统计。
// - 门禁由描述符 `capabilities.extract` 结构判定：provider 未声明 → 404；声明但未开放该协议（searxng）→ 405，不记统计。
// - 命中则复用 native 透传：任务打成 NativeTask{path=extract} 进队列 DO，走与 /search 完全相同的
//   重试/熔断/用量统计链路（上游 key 成败 + 冷却 + 分发 key 调用计数自动落账）。
// 前置门禁（405/404/401）不触达重试核 → 不计调用、不耗上游配额。

import { Context } from "hono";
import { Env, AppVariables } from "../../types";
import { PROVIDERS } from "../../providers";
import { runNative } from "../forward";

type Ctx = Context<{ Bindings: Env; Variables: AppVariables }>;

export async function handleExtract(c: Ctx): Promise<Response> {
  const auth = c.var.auth; // 中间件保证存在；错误响应已由 authenticate 短路
  try {
    const def = PROVIDERS[auth.provider];
    // 门禁与 native 透传统一走 runNative：能力未声明→404、未开放该协议→405、命中→转发队列 DO
    return await runNative(c, def, auth, "extract");
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return Response.json(
      { detail: { error: "Internal proxy error: " + msg } },
      { status: 502 }
    );
  }
}
