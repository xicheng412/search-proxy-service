import type { ProviderConfig } from "./index";

// Tavily 上游：所有事实聚合在单份描述符里。
export const TAVILY: ProviderConfig<"tavily"> = {
  name: "tavily",
  base: "https://api.tavily.com",
  capabilities: {
    search: { path: "/search", protocols: ["native", "searxng"] },
    extract: { path: "/extract", protocols: ["native", "reader"] },
  },
  upstream: { keysKey: "tavily_keys", idPrefix: "tv_", provider: "tavily" },
  admin: { basePath: "/admin/tavily", label: "Tavily Keys" },
  testBody: () => ({ query: "test", max_results: 1 }),
  // Tavily 官方错误体：{ detail: { error } }
  errorBody: (status, message) =>
    Response.json({ detail: { error: message } }, { status }),
  // 分类映射：值与重试 FSM 对 Tavily 的语义一致（432/433 为 Tavily 专属码）。
  statusClassMap: {
    429: "rate-limit",
    432: "rate-limit",
    433: "client-error",
    400: "client-error",
    404: "client-error",
    422: "client-error",
    401: "auth-error",
    403: "auth-error",
  },
  statusClassFallback: "server-error",
};
