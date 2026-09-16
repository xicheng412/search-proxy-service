// 入口侧打装/转发：入口管道把鉴权通过的请求打成可序列化任务，转发给所属 provider 的队列 DO。
// 原 src/proxy.ts 的 forwardToQueue / runNative 原样搬迁；runNative 的 auth 参数收口为 AuthContext
//（auth.protocol / auth.provider 用于门禁，auth.distKey.api_key 传给 forwardToQueue）。

import { Context } from "hono";
import { Env, AppVariables } from "../types";
import type { AuthContext } from "../types";
import type { ProviderConfig } from "../providers";
import type { Capability } from "../domain";
import type { NativeTask, QueueTask } from "../queue/task";

type Ctx = Context<{ Bindings: Env; Variables: AppVariables }>;

/** 把任务转发给所属 provider 的队列 DO，返回 DO 最终响应（持连接等待其时间片）。 */
export async function forwardToQueue(
  c: Ctx,
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
 * （/search 的 searxng 分支、/reader 的 reader 分支），不经此处。
 * 命中则打 NativeTask{path=surface.path} 进队列 DO。供 /search(native) 与 /extract 复用。 */
export async function runNative(
  c: Ctx,
  def: ProviderConfig,
  auth: AuthContext,
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
