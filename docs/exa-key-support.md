# Exa Key 管理、透明代理与分发 Key 前缀路由 · 实施记录

> 状态：**已实施完成**（typecheck 通过，`pnpm dev` 冒烟验证通过，含真实打到 api.exa.ai 的验证）。
> 关键决策：① exa 与 tavily 独立 KV 数组 + 泛型 CRUD（零迁移）；② 文件按 provider 拆分（admin/views 各一份，公共脚手架共享）；③ 分发 Key 改为**纯字符串 + 前缀路由**：请求 `Bearer <provider>-<key>`，前缀决定路由到哪个上游；④ 无前缀/裸 key 一律 401；⑤ 当日调用按 provider 拆分统计；⑥ 旧 `tvly-` 格式分发 Key **作废**，重新生成。

## 1. 目标

1. 新增 **Exa Keys** 管理（与 Tavily Keys 等价）：列表/新增（可 test call）/启用停用/删除/备注编辑，含每日成功失败统计与熔断冷却。
2. 实现 **Exa 透明代理**：统一入口 `POST /search`，按请求前缀选择上游，Bearer 换上游真实 key，结果原样透传；统计/熔断/429 切 key 重试与 Tavily 一致。
3. **分发 Key 前缀路由**：Key 为纯随机字符串，不绑定 provider；请求时 `tavily-<key>` → Tavily，`exa-<key>` → Exa。

## 1.1 概念区分（术语）

- **上游服务 key（外部真实 key）**：Tavily / Exa 官方签发的 key，在后台 “Tavily Keys” / “Exa Keys” 页管理（列表脱敏），仅由本服务持有，转发时替换进请求头。
- **分发 key（调用凭据）**：纯随机字符串，在 “分发 Keys” 页生成。调用本服务时写成 `Bearer tavily-<分发key>` 或 `Bearer exa-<分发key>`，前缀即路由选择。
- **复制按钮语义**：列表里的 “复制 tavily 调用key / 复制 exa 调用key” 复制的是组装好的**调用凭据**（`tavily-<key>` / `exa-<key>`），**不是**外部服务 key。

## 2. Exa 官方接口事实（已查证）

| 项 | 值 |
|---|---|
| Base URL | `https://api.exa.ai` |
| 鉴权 | `Authorization: Bearer <key>`（与 Tavily 同构，Bearer 替换可复用） |
| 端点 | `POST /search`（本计划仅暴露此端点） |
| 错误体 | 非 429：`{ requestId?, error, tag }`；429：`{ error: "..." }` —— 与 Tavily 的 `{detail:{error}}` 不同，必须按 provider 区分 |
| key 格式 | 无公开前缀/长度 → 做前缀校验，`maskKey` 通用 |

## 3. 数据模型

```ts
export type Provider = "tavily" | "exa";
export type KeyStatus = "enabled" | "disabled";

export interface CoreKey {            // 上游 key，TavilyKey = CoreKey，ExaKey = CoreKey
  id: string;                          // tk_* / ek_*
  key: string;                         // 上游真实 key
  name: string; status: KeyStatus;
  cooldown_until: number | null;
  created_at: number;
}

export interface DistributedKey {
  api_key: string;                     // 纯随机字符串（hex，不含 `-`，无品牌前缀）
  note: string;
  status: KeyStatus;
  created_at: number;
  plain_viewed: boolean;
}

export interface DistStats { tavily: number; exa: number; }  // 当日调用：按 provider 拆分
```

无 provider 分支的三层结构：`domain.ts`（纯领域：类型 + `parseDistKey` 前缀路由规则 + 值语义，零依赖）、`repo.ts`（KV 持久化 + 统计 + 熔断，依赖 domain）、`proxy.ts`（应用编排，由 `providers/*.ts` 描述符驱动）；admin/views 按 provider 拆文件（`admin/tavily.ts`、`admin/exa.ts`、`views/tavily.ts`、`views/exa.ts`），公共脚手架在 `admin/index.ts` / `views/index.ts`。

## 4. 请求认证：前缀路由

```
Authorization: Bearer <provider>-<key>
                        └─┬──┘ └─┬─┘
                     必须 tavily / exa   查库的 api_key（精确匹配）
```

- `parseDistKey(token)`：按第一个 `-` 切分 → 前缀（大小写不敏感，归一化小写）= provider；右侧 = api_key。生成 key 不含 `-`，切分无歧义。
- 前缀合法但 key 无效/禁用 → 401，用**该 provider 自己的错误格式**。
- 无 token / 前缀非法（如 `tvly-`、裸 key）→ 401，提示 `Bearer <tavily|exa>-<key>`（provider 未知，用 Tavily 默认格式）。
- 路由：`handleSearch` → `authenticate` 得 `{ provider, apiKey, distKey }` → `handleProviderProxy(c, PROVIDERS[provider], "/search", apiKey)`。

## 5. 代理与统计

- `handleProviderProxy`：加权随机选 key（权重 `1/(fail+1)`，排除 disabled/冷却）→ 无可用 503（该 provider 格式）→ 透明转发 → 429 切同 provider 另一 key 重试一次 → 2xx/其他分类 {成功/失败 + 熔断} → 原样透传。
- 分发 key 当日调用按 provider 拆分：`incrementDistCalls(kv, apiKey, provider, date)` → `dist_stats:{key}:{date}` = `{ tavily, exa }`。

## 6. 管理后台

- **Tavily Keys / Exa Keys**：列表（key 脱敏、备注可编辑、状态、冷却、当日成功/失败）、新增（可选 test call 分别打各自上游）、启用/停用、删除。
- **分发 Keys**：生成（纯随机字符串，明文只在生成响应显示一次，带前缀用法提示）、启用/停用、删除；列表显示当日调用并拆 `T Tavily n / Exa m`；每行提供 **复制 tavily 调用key / 复制 exa 调用key** 按钮——复制组装好的调用凭据 `tavily-<key>` / `exa-<key>`（非外部服务 key，完整明文按需注入行内供一键复制）。
- Dashboard：Tavily/Exa/分发 Key 统计卡 + 今日调用（= 各 key 的 tavily+exa 之和）。

## 7. 兼容与迁移

- **新分发 key**：纯字符串；请求必须带 `tavily-`/`exa-` 前缀，裸 key 401。
- **旧 `tvly-` 分发 key**：按决策**作废**，dev KV 中已清除 `distributed_keys`，需重新生成。
- 上游 `tavily_keys` / `exa_keys` 数据、统计 `stats:{id}:{date}`、熔断 `breaker:{id}` 结构不变，零迁移。

## 8. 边界与风险

- Exa key 无公开前缀 → 新增表单不做前缀校验，只做可选 test call（最小体 `{query:"test"}`，`/search` 有内容计费）。
- 代理内错误体一律走 `PROVIDERS[provider].errorBody`，禁止硬编码 Tavily 格式。
- views 两套列表模板按确认复制，布局改动需同步两处。

## 9. 验收冒烟（已执行）

- Exa key CRUD（add/toggle/delete/name）、Dashboard/列表渲染通过。
- `exa-<key>` → 真实打到 `api.exa.ai`，返回 `{requestId, resolvedSearchType, results[]}`；无效上游 key → 401 `{requestId,error,tag}` 透传。
- `tavily-<key>` → 无可用上游 → 503 `{detail:{error}}`（Tavily 格式）；验证与 Exa 隔离。
- 裸 key / `tvly-` 前缀 → 401 并提示正确格式。
- typecheck（tsc --noEmit）零错误。
