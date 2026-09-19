// native 执行器（透传）：drain 侧把上游响应原样透传给请求端。
// 不依赖 Hono——由队列 DO 调用，只消费 CoreDeps + ProviderConfig + NativeTask。

import { searchWithRetry, type CoreDeps } from "../../domain-services/retry-state-machine";
import type { ProviderConfig } from "../../providers";
import type { NativeTask } from "../../queue/task";

/** 把上游的响应原样透传给请求端（重写响应头，去掉会泄漏信息/冲突的头）。 */
function passthrough(res: Response): Response {
  const newHeaders = new Headers(res.headers);
  return new Response(res.body, {
    status: res.status,
    statusText: res.statusText,
    headers: newHeaders,
  });
}

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
