// reader 执行器（转换）：drain 侧 GET /reader/<url> → Tavily Extract 请求 → 转纯文本。
// 不依赖 Hono——由队列 DO 调用，只消费 CoreDeps + ProviderConfig + ReaderTask。

import { searchWithRetry, type CoreDeps } from "../../domain-services/retry-state-machine";
import type { ProviderConfig } from "../../providers";
import type { ReaderTask } from "../../queue/task";
import { buildExtractBody, toTextResponse, readerError } from "../../adapters/reader";

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
