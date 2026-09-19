// 基础设施层·上游传输端口（UpstreamTransport）。
// 把"对上游 provider 的一次 POST 调用"从重试 FSM 中剥离，作为可替换端口：
// FSM 只依赖本模块签名（经 CoreDeps.transport 注入，见 retry-state-machine），
// 测试可 mock 全局 fetch 拦截，不依赖本模块内部细节。
// 不 import 仓库其它模块（除 providers 的类型），利于独立测试与未来换实现。

import type { ProviderConfig } from "./providers";

/** 单次上游请求超时（网络无响应视为失败，换 key 重试）。 */
const UPSTREAM_TIMEOUT_MS = 30_000;

/**
 * 一次上游 POST 调用：透传上游 key、请求体与 content-type，30s 超时。
 * 网络异常/超时由 fetch 抛错，调用方（FSM 的 in-flight 分支）按失败换 key。
 */
export async function upstreamFetch(
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
