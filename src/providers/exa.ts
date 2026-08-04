import type { ProviderConfig } from "./index";

// Exa 上游：所有事实聚合在单份描述符里。
export const EXA: ProviderConfig<"exa"> = {
  name: "exa",
  base: "https://api.exa.ai",
  endpoints: { search: "/search" },
  upstream: { keysKey: "exa_keys", idPrefix: "ek_" },
  admin: { basePath: "/admin/exa", label: "Exa Keys" },
  testBody: () => ({ query: "test" }),
  // Exa 官方错误体：{ error }（429 与通用错误同形；requestId/tag 为官方附带，缺省即可）
  errorBody: (status, message) =>
    Response.json({ error: message }, { status }),
};
