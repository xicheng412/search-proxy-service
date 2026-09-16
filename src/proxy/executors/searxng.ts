// searxng 执行器（转换）：drain 侧把 Tavily 上游响应转成 SearXNG 标准 JSON。
// 不依赖 Hono——由队列 DO 调用，只消费 CoreDeps + ProviderConfig + SearxngTask。

import { searchWithRetry, type CoreDeps } from "../../retry";
import type { ProviderConfig } from "../../providers";
import type { SearxngTask } from "../../queue/task";
import { toSearxngResponse, searxngError } from "../../adapters/searxng";

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
