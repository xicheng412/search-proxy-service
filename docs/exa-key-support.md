# Exa 集成参考（历史实施记录）

> **状态**：本文档记录 Exa 集成的设计决策与实施过程，**作为历史参考保留**。
> 当前实现以 [`architecture.md`](./architecture.md) 与代码为准。文中"已实施完成"的状态保持有效，但部分早期草案细节（如 `plain_viewed` 字段）已在最终代码中舍弃。

---

## 1. 背景与目标

Tavily 代理跑稳后，需要把同样的"多 key + 加权随机 + 熔断 + 透明代理"模式复用到 **Exa**（`api.exa.ai`）。同时重新审视了分发 key 的形态，因为旧实现（`tvly-` 前缀的 dist key）把"分发 key ↔ provider"绑死，新增 provider 就要重新签发，不可持续。

### 1.1 关键决策

1. **Exa 与 Tavily 独立 KV 数组 + 泛型 CRUD**：零迁移，向前兼容。
2. **文件按 provider 拆分**：`admin/{tavily,exa,keys,index}.ts` 与 `views/{tavily,exa,index}.ts` 镜像；公共脚手架共享。
3. **新增 provider 防腐层**：`src/providers/{tavily,exa,index}.ts` 描述符驱动泛型代码（proxy / storage / admin / views 都不写 `if (provider === "tavily")`）。
4. **分发 Key 改为"纯字符串 + 前缀路由"**：Key 不绑 provider，请求时 `tavily-<key>` / `exa-<key>` 决定路由。
5. **无前缀 / 裸 key / `tvly-` / `sk-` 一律 401**。
6. **当日调用按 provider 拆分**：`dist_stats:{key}:{date} = { tavily, exa }`。
7. **旧 `tvly-` 格式分发 Key 作废**（dev KV 中已清除 `distributed_keys`）。

### 1.2 概念区分（保留与现网一致）

- **上游 key**（Tavily / Exa 官方签发）：在后台 "Tavily Keys" / "Exa Keys" 页管理，列表脱敏（`tvly-****` 或 Exa 等价形式），仅本服务持有。
- **分发 key**（调用凭据）：纯高熵 hex 字符串，在 "分发 Keys" 页生成。调用时拼 `Bearer tavily-<分发key>` 或 `Bearer exa-<分发key>`，**前缀决定路由**。
- **复制按钮语义**：后台列表操作列 "复制" 下拉菜单里的 "复制 tavily 调用 key / 复制 exa 调用 key / 复制 searxng-tavily 调用 key" 复制的是**组装好的调用凭据**（`tavily-<key>` / `exa-<key>` / `searxng-tavily-<key>`），**不是** 外部服务 key。

---

## 2. Exa 官方接口事实（已查证）

| 项 | 值 |
|---|---|
| Base URL | `https://api.exa.ai` |
| 鉴权 | `Authorization: Bearer <key>`（与 Tavily 同构，可复用 Bearer 替换路径） |
| 端点 | `POST /search`（当前阶段仅暴露此端点） |
| 错误体 | 非 429：`{ requestId?, error, tag }`；429：`{ error: "..." }` |
| 错误体封装 | 简化为 `{ error: "..." }`，requestId / tag 缺省即可 |
| key 格式 | 无公开前缀 / 长度 → 不做前缀校验，`maskKey` 通用即可 |

> 这一段在 `src/providers/exa.ts` 落地为 `errorBody(status, msg) => Response.json({ error: msg }, { status })`。

---

## 3. 数据模型（最终版）

```ts
// src/domain.ts
export type Provider = "tavily" | "exa";
export type KeyStatus = "enabled" | "disabled";

export interface CoreKey {            // 上游 key; TavilyKey = CoreKey, ExaKey = CoreKey
  id: string;                          // tk_* / ek_*
  key: string;                         // 上游真实 key
  name: string;
  status: KeyStatus;
  cooldown_until: number | null;
  created_at: number;
}

export interface DistributedKey {
  api_key: string;                     // 纯高熵 hex, 不含 "-", 无品牌前缀
  note: string;
  status: KeyStatus;
  created_at: number;
}

export interface DistStats { tavily: number; exa: number; }
```

> ⚠️ **关于 `plain_viewed`**：早期草案里 `DistributedKey` 包含 `plain_viewed: boolean` 字段（用于"明文只显示一次 + 二次密码重新查看"流程）。该流程最终**未实施**——后台采用"行内注入明文 + 一键复制"替代。**当前类型不含 `plain_viewed`**，不要按旧文档去读这个字段。

### 3.1 分层落地

| 层 | 文件 | 职责 |
|---|---|---|
| 纯领域（零依赖） | `src/domain.ts` | 类型 + `parseDistKey` 前缀路由规则 + 值语义 + 熔断常量 |
| 持久化 | `src/storage.ts` | KV 纯读写原语 + Keys 数组泛型 CRUD |
| 统计缓冲 | `src/usage-store.ts` | 内存累积 + 节流 flush + 读叠加 |
| 熔断 | `src/circuit-breaker.ts` | 连续失败计数 → 冷却；与统计分离 |
| 应用编排 | `src/proxy.ts` | 鉴权 + 选 key + 转发 + 分类，由描述符驱动 |
| Provider 防腐 | `src/providers/{tavily,exa,index}.ts` | 一个 provider 的全部事实 |
| 管理路由 | `src/admin/{tavily,exa,keys,index}.ts` | 后台路由 + 鉴权 + 调 storage / usage-store |
| 视图模板 | `src/views/{tavily,exa,index}.ts` | HTMX 片段 + 渲染函数 |

---

## 4. 请求认证：前缀路由

```
Authorization: Bearer <provider>-<key>
                        └─┬──┘ └─┬─┘
                  必须 tavily / exa   查库的 api_key（精确匹配）
```

- `parseDistKey(token)`（[`src/domain.ts`](../src/domain.ts)）：按第一个 `-` 切分；前缀（大小写不敏感，归一化小写）= provider；右侧 = api_key。生成 key 是 hex 不含 `-`，切分无歧义。
- 前缀合法但 key 无效 / 禁用 → 401，**用该 provider 自己的错误格式**。
- 无 token / 前缀非法（`tvly-` / 裸 key） → 401，提示 `Bearer <tavily|exa>-<key>`（provider 未知，用 Tavily 默认格式）。
- 路由：`handleSearch` → `authenticate` 得 `{ provider, apiKey, distKey }` → `handleProviderProxy(c, PROVIDERS[provider], "/search", apiKey)`。

---

## 5. 代理与统计

- `handleProviderProxy`（[`src/proxy.ts`](../src/proxy.ts)）：
  - 加权随机选 key（`1 / (fail+1)`，排除 disabled / 冷却）
  - 无可用 → 503（该 provider 格式）
  - 透明转发
  - 429 → 切同 provider 另一 key 重试一次
  - 2xx / 其他 → 分类 {成功 / 失败 + 熔断} → 原样透传
- 分发 key 当日调用按 provider 拆分：`recordDistCall(apiKey, provider, date)` → `dist_stats:{key}:{date} = { tavily, exa }`。

### 5.1 统计精度（与 [`architecture.md` §5.1](./architecture.md) 一致）

`usage-store.ts` 是**写回式近似统计**：内存累积 → 节流 flush（默认 5s 间隔）→ KV；读时叠加本实例未 flush 增量。同一 isolate 立即可见，跨 isolate 最多一间隔延迟，isolate 回收时丢失 ≤ 一间隔量。写失败静默，绝不阻塞主流程。

---

## 6. 管理后台结构

- **Tavily Keys / Exa Keys**：列表（key 脱敏、备注可编辑、状态、冷却、当日成功/失败）、新增（可选 test call 分别打各自上游）、启用/停用、删除。
- **分发 Keys**：生成（纯随机字符串，明文只在生成响应显示一次，带前缀用法提示）、启用/停用、删除；列表最近24h调用拆为 **Tavily(24H) / EXA(24H)** 两列；操作列 "复制" 下拉菜单含 **复制 tavily 调用 key / 复制 exa 调用 key / 复制 searxng-tavily 调用 key**——复制组装好的调用凭据。
- **使用说明页 (`/admin/help`)**：原理与概念区分、两种 curl 调用示例、端点与错误表、文档索引。
- **Dashboard**：Tavily / Exa / 分发 Key 统计卡 + 今日调用（= 各分发 key 的 tavily+exa 之和）。

> **关于"明文只显示一次"**：早期设计是"生成后明文只在响应里露一次 + 之后只显示脱敏 + 提供二次密码重新查看"。最终改为"明文按需注入列表行内供一键复制"，更轻量也更适合反复复制给多个 provider 调用的场景。

---

## 7. 兼容与迁移

- **新分发 key**：纯 hex 字符串；请求必须带 `tavily-` / `exa-` 前缀，裸 key 401。
- **旧 `tvly-` 分发 key**：按决策**作废**。dev KV 中已清除 `distributed_keys`，需重新生成。
- **上游 `tavily_keys` / `exa_keys` 数据、统计 `stats:{id}:{date}`、熔断 `breaker:{id}` 结构不变**，零迁移。

---

## 8. 边界与风险（保留）

- Exa key 无公开前缀 → 新增表单不做前缀校验，只做可选 test call（最小体 `{query:"test"}`，`/search` 有内容计费）。
- 代理内错误体一律走 `PROVIDERS[provider].errorBody`，**禁止**在 proxy / admin 里硬编码 Tavily 格式。
- `views/{tavily,exa}.ts` 两套列表模板按确认复制，**布局改动需同步两处**（未来若模板继续分化可考虑抽出公共部分）。

---

## 9. 验收冒烟（已执行）

- Exa key CRUD（add / toggle / delete / name）、Dashboard / 列表渲染通过。
- `exa-<key>` → 真实打到 `api.exa.ai`，返回 `{requestId, resolvedSearchType, results[]}`；无效上游 key → 401 `{error}` 透传。
- `tavily-<key>` → 无可用上游 → 503 `{detail:{error}}`（Tavily 格式）；与 Exa 隔离（不会因为 Exa 列表里没 key 串到 Tavily）。
- 裸 key / `tvly-` 前缀 → 401 并提示正确格式。
- `pnpm build`（`tsc --noEmit`）零错误。

---

## 10. 后续阶段（这一段也作为历史存档）

为承载上面这些改动，代码引入了一批新文件 / 命名；新读者直接读 [`architecture.md`](./architecture.md) 即可，这里不重复。计划内后续路线（被 Exa 集成"顺带"完成或搁置的）：

- ~~"明文只显示一次 + 二次密码重新查看"流程~~ → 改用"行内注入 + 一键复制"（更轻）。
- ~~"分发 key 加 quota / 过期"~~ → 暂未做，分布式 key 当前无 quota 字段。
- ~~"通用 key 测试调用框架"~~ → 已通过 `PROVIDERS[name].testBody` 落地，每个 provider 自带最小请求体。
