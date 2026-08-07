# 项目原始需求与交付计划（历史参考）

> **状态**：本文档为项目初版需求与交付计划的存档，**记录的是设计意图与当时的认知**。当前实现以 [`architecture.md`](./architecture.md) 与代码为准。
>
> 读这份文档时请把它当作"为什么这样设计"的考古资料——具体接口、字段、目录结构可能与现实有出入。

---

## 0. 与当前实现的差异速查

为方便从历史视角读这份文档，先列出**计划里写过、但实现已变更**的项：

| 计划原文 | 当前实现 | 出处 |
|---|---|---|
| 目录结构建议 `kv.ts` 作为数据层 | 实际为 `storage.ts` + `usage-store.ts` + `circuit-breaker.ts` 三层分立 | `src/` 目录 |
| 单 provider：仅代理 Tavily | 多 provider：Tavily + Exa，对称结构 | `src/providers/` |
| 后台"区块 A / 区块 B"两页 | Dashboard + Tavily / Exa / 分发 Keys 三页 + Help 页 | `src/admin/`, `src/views/` |
| 分发 Key 形如 `sk-<随机串>` | 纯 hex 字符串，**无 `sk-` 前缀**；调用时拼 `tavily-` / `exa-` | `src/domain.ts` |
| "明文 key 只显示一次 / 二次密码重新查看明文" | **未实现**。明文按需注入列表行内供一键复制（"复制 tavily / exa 调用 key" 按钮） | `src/admin/keys.ts`, `src/views/` |
| `DistributedKey` 含 `plain_viewed` 字段 | **未实现**。当前字段：`api_key / note / status / created_at` | `src/domain.ts` |
| KV 统计"单次 PUT 合并 success/fail" | 用 `usage-store.ts` 写回式：内存累积 + 节流 flush + 读叠加 | `src/usage-store.ts` |
| 熔断"连续失败 ≥ 5 次冷却 60 秒" | **已实现**，常量定义在 `src/domain.ts`（`COOLDOWN_THRESHOLD=5`, `COOLDOWN_MS=60_000`） | `src/domain.ts`, `src/circuit-breaker.ts` |
| 单一入口 `POST /search` 代理 Tavily | 同一入口按 Bearer 前缀路由到 Tavily 或 Exa | `src/proxy.ts` |
| 错误体按 Tavily 格式 | 按 provider 区分：Tavily `{detail:{error}}`，Exa `{error}` | `src/providers/` |
| 管理员认证："HttpOnly + SameSite=Lax + 24h + CSRF" | **已实现**，外加 `secure: true`；CSRF 用恒定时间比较 | `src/auth.ts` |

下文保留原计划文本，**不做改动**，仅在最后追加"实施完成情况"汇总。

---

## 1. 业务本质（原始设计意图）

这是一个"OpenAI 式"的 API 密钥分发服务：
- 我自己持有上游服务（Tavily）的真实 API Key。
- 系统对外提供一个统一入口，向下游使用者分发**独立的访问 Key**。
- 外部调用者用自己的访问 Key 调我的接口，我代为请求上游并返回结果。
- 我在中间层做鉴权、转发、密钥管理和数据统计。

> 这一段在 Exa 集成时被扩展为"对称多 provider"——`src/providers/` 描述符让新增上游无需改逻辑。

## 2. 技术栈约束

- 框架：Hono（TypeScript）
- 运行时：Cloudflare Workers
- 部署/CLI：Wrangler（V3+，实际锁定 v4，部署用 `pnpm run deploy:cf` 而非 `pnpm deploy`）
- 存储：Cloudflare Workers KV
- 管理后台前端：HTMX + 原生 HTML（无 SPA 框架）

## 3. 系统架构

```
外部调用方(分发key) ──▶ 你的 Worker(Hono) ──▶ Tavily 上游API
                          │
                          ├─ 请求代理层(校验分发key→转发搜索→返回→统计)
                          └─ 管理后台(管理员密码登录, 两块页面)
                               ├ 管理 Tavily Key(含每日统计)
                               └ 管理/生成分发 Key
数据全部存于 KV
```

> 实际实现是 3 块（Tavily / Exa / 分发）+ Dashboard + Help；上游也是 2 个。

## 4. 详细需求

### 4.1 管理员认证

- `wrangler secret put ADMIN_PASSWORD`，代码读 `env.ADMIN_PASSWORD`。
- 密码**不在后台修改**。
- 会话 Cookie：包含会话 ID + 过期时间；过期时长 24h。
- Cookie：`HttpOnly` + `SameSite=Lax` + `secure`。
- 管理后台所有**写操作**（增删改、生成 key、切换状态）需校验登录态 + CSRF token。

> **实施状态**：✅ 全部实现。CSRF 用表单隐藏字段 `csrf_token` 提交，服务端用恒定时间字符串比较防时序侧信道。

### 4.2 Tavily Key 管理（原始阶段；当前已扩展为对称的多 provider）

- 支持**多个** Tavily Key。
- 字段：`id`、`key`（`tvly-` 开头）、`name`、`status`、`cooldown_until`。
- **请求派发策略**：
  1. 只从 `status=enabled` 且 `cooldown_until <= now` 中选取。
  2. 加权随机：权重 `1 / (当日失败数 + 1)`，0 失败最高。
  3. 连续失败 ≥ 5 → 冷却 60 秒。
- **每日统计**：成功 / 失败（best-effort 近似值）。

> **实施状态**：✅ 全部实现，参数定义在 [`src/domain.ts`](../src/domain.ts) `COOLDOWN_THRESHOLD` / `COOLDOWN_MS`。
> **扩展**：同样的"多 key + 加权 + 熔断 + 当日统计"模式被对称地复刻到 Exa，由 `src/providers/exa.ts` 描述符驱动。

### 4.3 分发 Key 管理

- 字段：`api_key`（高熵随机）、`note`（必填）、`status`、`created_at`。
- **不支持**配额 / 过期时间。
- 操作：生成新 Key、单独删除、启用/禁用。
- 计划要求："明文 key 只显示一次；提供二次密码确认重新查看明文"。

> **实施状态**：⚠️ 部分变更。**未实现** 二次密码查看；明文按需注入列表行内供"复制 tavily 调用 key / 复制 exa 调用 key" 按钮使用。
> **形态变更**：原计划 `sk-xxx` 改为纯 hex 不带前缀；调用方拼 `Bearer tavily-<key>` / `Bearer exa-<key>` 决定路由（见 [`exa-key-support.md`](./exa-key-support.md)）。

### 4.4 对外 API（代理层）

- 唯一端点：`POST /search`。
- 鉴权：`Authorization: Bearer <分发key>`。
- 流程：取分发 key → KV 查 → 不存在或 disabled 返回 401 → 增加当日调用计数 → 加权随机 + 熔断选上游 key → 转发 → 按 2xx/429/401/5xx 分类处理 → 透传。

> **实施状态**：✅ 全部实现。**扩展**：当前按分发 key 的 `<provider>-` 前缀路由到对应上游；429 切同 provider 的另一 key 重试一次。

### 4.5 管理后台页面

计划仅两块（"区块 A Tavily / 区块 B 分发"）。当前实现是 Dashboard + 三块 + Help：

| 路径 | 用途 |
|---|---|
| `GET /admin` | Dashboard：Tavily / Exa / 分发 key 统计卡 + 今日调用总数 |
| `GET /admin/tavily` | Tavily Keys 列表（脱敏、备注可编辑、状态、冷却、当日成功/失败） |
| `GET /admin/exa` | Exa Keys 列表（同上） |
| `GET /admin/keys` | 分发 Keys 列表（脱敏、状态、创建时间、当日调用按 provider 拆分、复制按钮） |
| `GET /admin/help` | 使用说明（原理、概念区分、两种 curl 示例、端点与错误表、文档索引） |

## 5. KV 数据模型（原始建议）

```
tavily_keys            → JSON 数组, 存所有 Tavily Key 对象
distributed_keys       → JSON 数组, 存所有分发 Key 对象
stats:{tavilyKeyId}:{YYYY-MM-DD}         → JSON { success, fail }
dist_stats:{distKeyId}:{YYYY-MM-DD}      → JSON { calls }
```

> **当前实现差异**：
> - 新增 `exa_keys`（对称 Tavily）。
> - `dist_stats` 的 value 改为 `{ tavily, exa }`（按 provider 拆分），而不是单一 `calls`。
> - 新增 `breaker:{upstreamKeyId}`（连续失败计数，独立 KV 空间）。
> - 新增 `session:{sid}`（管理员会话）。
> - 所有每日 / 会话 / breaker key 都带 TTL，避免无限增长。

## 6. 技术实现要点

1. **顺序执行**：按交付要求逐步实现。
2. **Wrangler secrets**：管理员密码用 `wrangler secret put ADMIN_PASSWORD`。
3. **Worker 配置**：`wrangler.toml` 中配置 KV binding。
4. **安全**：管理后台所有写操作校验登录态 + CSRF；Cookie HttpOnly + SameSite + secure；分发 key / Tavily key 在列表中一律脱敏；明文 key 不落日志；KV 权限只对本服务可见。
5. **目录结构**（原始建议 vs 当前实现见 `docs/architecture.md §7`）。

## 7. 交付要求

1. **A. 项目脚手架**：Hono + TypeScript + Wrangler + KV binding + `/` 健康检查 → ✅
2. **B. KV 数据层**：Keys 增删改查 + 状态切换 + 脱敏 + 每日统计（跨天重置、近似值） → ✅（实际由 `storage.ts` + `usage-store.ts` 共同承担）
3. **C. 管理员认证**：密码登录 + 24h 会话 Cookie + CSRF + 登出 → ✅
4. **D. 管理后台页面**：HTMX 实现 Tavily / 分发 Key 管理 + 明文只显示一次 + 二次密码确认 → ⚠️ 明文只显示一次已部分实现（行内注入 + 复制按钮）；二次密码确认**未实现**
5. **E. 代理层**：`POST /search` + 鉴权 + 加权 + 熔断 + 分类 + 503 → ✅（**额外**支持按 Bearer 前缀路由到 Tavily / Exa）

## 8. 后续阶段（Exa 集成）

Exa 是后来加的。完整设计与决策见 [`exa-key-support.md`](./exa-key-support.md)；要点：

- 用 `src/providers/exa.ts` 描述符驱动，复用所有泛型代码。
- 分发 Key 改为"纯字符串 + 前缀路由"，旧 `tvly-xxx` 形式作废。
- 错误体格式按 provider 区分（Tavily `{detail:{error}}`，Exa `{error}`）。
- 当日调用按 provider 拆分。
- 新增 `usage-store.ts` 写回式统计层（替代原计划"单次 PUT 合并"思路），把日内 IO 降一档。
- 新增 `circuit-breaker.ts` 独立模块（breaker 计数带 10 分钟 TTL）。
