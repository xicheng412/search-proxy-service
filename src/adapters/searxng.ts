// 调用侧协议适配层（消费方 ACL）：把 SearXNG 线协议转为上游 Tavily 请求、再把 Tavily
// 响应转为 SearXNG 标准 JSON。纯函数、零依赖——不 import 本仓库任何模块，便于单测。
// 与新 provider 的关系：本文件只负责"协议转换"；路由/上游坐标见 providers/ 与 proxy.ts。
// searxng 标准依据官方源码：webutils.get_json_response + result_types/_base.MainResult.as_dict
// （searxng JSON 顶层无 number_of_results 字段，勿补）。

export interface SearxngParams {
  query: string;
  format?: string; // searxng format 参数（仅支持 json）
  categories?: string; // 逗号分隔，如 "general,news"
  pageno?: number;
  timeRange?: "day" | "month" | "year";
}

export interface SearxngError {
  status: number;
  message: string;
}

/** searxng 结果固定取 Tavily 10 条（不暴露扩展参数，避免计费膨胀）。 */
const SEARXNG_MAX_RESULTS = 10;

/**
 * 解析 SearXNG 请求参数（已归一化成 kv 的对象，如表单/query string）。
 * 返回 params 或 error。非法/缺失的字段一律不报错（接受失真），仅 q 与 format 强校验。
 */
export function parseSearxngParams(record: Record<string, string>): {
  params?: SearxngParams;
  error?: SearxngError;
} {
  const query = (record["q"] ?? "").trim();
  if (!query) {
    return { error: { status: 400, message: "query parameter 'q' is required" } };
  }
  const format = record["format"]?.trim() || undefined;
  if (format && format !== "json") {
    return {
      error: {
        status: 400,
        message: `unsupported format: ${format}; only 'json' is supported`,
      },
    };
  }
  const pageno = Number.parseInt(record["pageno"] ?? "", 10);
  const timeRange = record["time_range"] as "day" | "month" | "year" | undefined;
  return {
    params: {
      query,
      format,
      categories: record["categories"]?.trim() || undefined,
      pageno: Number.isFinite(pageno) ? pageno : undefined,
      timeRange:
        timeRange === "day" || timeRange === "month" || timeRange === "year"
          ? timeRange
          : undefined,
    },
  };
}

/** 判定 searxng 参数对应的 Tavily topic（null = 默认 general）。 */
export function resolveTopic(p: SearxngParams): "news" | null {
  const hasNews = (p.categories ?? "").split(",").some((c) => c.trim() === "news");
  if (hasNews || p.timeRange) return "news";
  return null;
}

/** 把 searxng 参数构造成 Tavily 上游请求体（返回对象，由调用方 JSON.stringify）。 */
export function buildTavilyBody(p: SearxngParams): Record<string, unknown> {
  const body: Record<string, unknown> = {
    query: p.query,
    max_results: SEARXNG_MAX_RESULTS,
  };
  const topic = resolveTopic(p);
  if (topic) body["topic"] = topic;
  if (p.timeRange) {
    // tavily 的 days 仅在 news topic 下生效，因此 time_range 强制 news
    body["days"] = p.timeRange === "day" ? 1 : p.timeRange === "month" ? 30 : 365;
  }
  // 其余 searxng 参数（language/safesearch/pageno）无 Tavily 对应，实测静默忽略（接受失真）。
  return body;
}

interface TavilyResult {
  title?: unknown;
  url?: unknown;
  content?: unknown;
  score?: unknown;
  published_date?: unknown;
}

interface TavilyResponse {
  query?: unknown;
  results?: unknown;
}

/**
 * 把 Tavily 上游响应转成 SearXNG 标准 JSON（顶层对象，由调用方 JSON.stringify）。
 * 字段集合对齐 searxng 官方 MainResult.as_dict + get_json_response。
 * 容错：results 缺失/非数组 / 单条字段缺失时都安全降级，不抛异常。
 */
export function toSearxngResponse(
  tavily: unknown,
  query: string,
  topic?: "news" | "general"
): Record<string, unknown> {
  const raw = (tavily ?? {}) as TavilyResponse;
  const results = Array.isArray(raw.results) ? (raw.results as TavilyResult[]) : [];
  const category = topic === "news" ? "news" : "general";
  const mapped = results.map((r, i) => ({
    title: typeof r.title === "string" ? r.title : "",
    url: typeof r.url === "string" ? r.url : "",
    content: typeof r.content === "string" ? r.content : "",
    engine: "tavily",
    engines: ["tavily"],
    template: "default.html",
    score: typeof r.score === "number" ? r.score : 0,
    publishedDate: typeof r.published_date === "string" ? r.published_date : null,
    category,
    positions: [i + 1],
  }));
  return {
    query: typeof raw.query === "string" ? raw.query : query,
    results: mapped,
    answers: [],
    corrections: [],
    infoboxes: [],
    suggestions: [],
    unresponsive_engines: [],
  };
}

/** SearXNG 官方错误格式：`{"error": msg}`（对齐 searxng webapp.index_error）。 */
export function searxngError(status: number, msg: string): Response {
  return Response.json({ error: msg }, { status });
}
