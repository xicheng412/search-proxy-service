// 调用侧协议适配层（消费方 ACL）：把 reader 线协议——GET /reader/<url>——转换为对 Tavily
// Extract 的一次上游请求，再把 Tavily Extract 响应转成纯文本（text/plain）。纯函数、零依赖
// ——不 import 本仓库任何模块，便于单测。
// 与 searxng.ts 对称：searxng 包装 Search、reader 包装 Extract。
// 协议是能力的属性/延伸，不是能力本身：reader 只包装 Extract。当前实现覆盖 Extract×tavily；
// 新增 Exa 方向是实现扩展，不是新能力。
// 语义边界：本协议返回的是 Tavily 提取后的正文文本（raw_content），不是 Jina Reader 的
// 精加工 Markdown——质量由 Tavily 决定，本层只做"转 text/plain + 错误体"。

const READER_PREFIX = "/reader/";

/** 目标 URL 的默认提取深度（v1 固定 basic：只抓主文，快、省配额；advanced 为未来扩展）。 */
const READER_EXTRACT_DEPTH = "basic" as const;

/** 从 /reader/<url> 路径抠出目标 URL；缺目标或非法 percent-encode 返回 null。 */
export function parseReaderTarget(path: string): string | null {
  if (!path.startsWith(READER_PREFIX)) return null;
  const rest = path.slice(READER_PREFIX.length);
  if (!rest) return null;
  try {
    return decodeURIComponent(rest);
  } catch {
    return null; // 畸形 % 序列
  }
}

/** 把 reader 目标 URL 构造成 Tavily Extract 上游请求体（返回对象，由调用方 JSON.stringify）。 */
export function buildExtractBody(url: string): Record<string, unknown> {
  return { urls: [url], extract_depth: READER_EXTRACT_DEPTH };
}

/**
 * 从 Tavily Extract 响应里挑出目标 URL 的 raw_content，转成 text/plain 响应。
 *   - 目标命中 → 200 text/plain（raw_content）
 *   - 目标在 failed_results（确定性失败，重试无意义）→ readerError(502)，不消耗下一次 key
 *   - 响应畸形 / 无该目标的结果 → null（视为"成功但响应不可用"，由重试核换 key 重试）
 * 返回 null 时调用方按重试核"unusable"语义处理；其它情况返回值即最终响应。
 */
export function toTextResponse(raw: unknown, targetUrl: string): Response | null {
  const resp = (raw ?? {}) as {
    results?: Array<{ url?: unknown; raw_content?: unknown }>;
    failed_results?: Array<{ url?: unknown; error?: unknown }>;
  };
  const target = String(targetUrl);

  // 命中结果（取第一个匹配，raw_content 非空才视为可用）
  if (Array.isArray(resp.results)) {
    const hit = resp.results.find(
      (r) => r && r.url === target && typeof r.raw_content === "string" && r.raw_content.length > 0
    );
    if (hit) {
      return new Response(hit.raw_content as string, {
        status: 200,
        headers: { "content-type": "text/plain; charset=utf-8" },
      });
    }
  }

  // 目标显式失败：确定性错误，不重试（避免对死链空烧配额）
  if (Array.isArray(resp.failed_results)) {
    const failed = resp.failed_results.find((r) => r && r.url === target);
    if (failed && typeof failed.error === "string") {
      return readerError(502, `failed to fetch ${target}: ${failed.error}`);
    }
  }

  return null;
}

/** reader 协议错误体：`{"error": msg}`（对齐 searxng 风格，/reader 面统一 JSON 错误）。 */
export function readerError(status: number, msg: string): Response {
  return Response.json({ error: msg }, { status });
}
