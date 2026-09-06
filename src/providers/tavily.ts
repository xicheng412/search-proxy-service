import type { ProviderConfig } from "./index";

// Tavily 上游：所有事实聚合在单份描述符里。
export const TAVILY: ProviderConfig<"tavily"> = {
  name: "tavily",
  base: "https://api.tavily.com",
  capabilities: {
    search: { path: "/search", protocols: ["native", "searxng"] },
    extract: { path: "/extract", protocols: ["native"] },
  },
  upstream: { keysKey: "tavily_keys", idPrefix: "tv_", provider: "tavily" },
  admin: { basePath: "/admin/tavily", label: "Tavily Keys" },
  testBody: () => ({ query: "test", max_results: 1 }),
  // Tavily 官方错误体：{ detail: { error } }
  errorBody: (status, message) =>
    Response.json({ detail: { error: message } }, { status }),
};
