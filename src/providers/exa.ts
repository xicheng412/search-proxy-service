import type { ProviderConfig } from "./index";

// Exa 上游：所有事实聚合在单份描述符里。
export const EXA: ProviderConfig<"exa"> = {
  name: "exa",
  base: "https://api.exa.ai",
  capabilities: { search: { path: "/search", protocols: ["native"] } },
  upstream: { keysKey: "exa_keys", idPrefix: "ek_", provider: "exa" },
  admin: { basePath: "/admin/exa", label: "Exa Keys" },
  testBody: () => ({ query: "test" }),
  // Exa 官方错误体：{ error }（429 与通用错误同形；requestId/tag 为官方附带，缺省即可）
  errorBody: (status, message) =>
    Response.json({ error: message }, { status }),
  // 分类映射：432/433 是 Tavily 专属码，Exa 不产生；未列出的码走兜底，无可见行为变化。
  statusClassMap: {
    429: "rate-limit",
    400: "client-error",
    404: "client-error",
    422: "client-error",
    401: "auth-error",
    403: "auth-error",
  },
  statusClassFallback: "server-error",
};
