# 项目概述

请用 **Hono 框架** 构建一个部署在 **Cloudflare Workers** 上的 **API 密钥代理与管理平台**，使用 **Wrangler** 进行开发和部署，存储使用 **Cloudflare KV**，管理后台用 **HTMX + 原生 HTML**。

## 业务本质

这是一个"OpenAI 式"的 API 密钥分发服务：
- 我自己持有上游服务（Tavily）的真实 API Key。
- 系统对外提供一个统一入口，向下游使用者分发**独立的访问 Key**。
- 外部调用者用自己的访问 Key 调我的接口，我代为请求上游并返回结果。
- 我在中间层做鉴权、转发、密钥管理和数据统计。

## 技术栈约束

- 框架：Hono（TypeScript）
- 运行时：Cloudflare Workers
- 部署/CLI：Wrangler（V3+）
- 存储：Cloudflare Workers KV（所有数据存 KV）
- 管理后台前端：HTMX + 原生 HTML（无 SPA 框架）

## 系统架构

```
外部调用方(分发key) ──▶ 你的 Worker(Hono) ──▶ Tavily 上游API
                          │
                          ├─ 请求代理层(校验分发key→转发搜索→返回→统计)
                          └─ 管理后台(管理员密码登录, 两块页面)
                               ├ 管理 Tavily Key(含每日统计)
                               └ 管理/生成分发 Key
数据全部存于 KV
```

**两条主链路：**
1. **代理链路**：外部用分发 key 调搜索接口 → 校验 key → 加权随机选可用 Tavily key → 代为转发请求 → 返回结果 → 记录统计。
2. **管理链路**：管理员密码登录后台 → 管理 Tavily Keys、查看每日统计、管理/生成分发 Keys。

---

## 详细需求

### 一、管理员认证
- 使用部署时通过 `wrangler secret put ADMIN_PASSWORD` 配置的密码，代码从 `env.ADMIN_PASSWORD` 读取。
- 密码**不可在后台修改**。
- 登录态用会话 Cookie 实现：包含会话 ID + 过期时间；**会话过期时长定义为 24 小时，过期自动失效并要求重新登录**；提供登出接口。
- Cookie 需设置 `HttpOnly` 和 `SameSite=Lax`。
- 管理后台所有**写操作**（增删改、生成 key、切换状态）需校验登录态，**并使用 CSRF token 防护**（表单携带 token，服务端校验），防止跨站请求。

### 二、Tavily Key（上游真实密钥）管理
- 支持**多个** Tavily Key。
- 每个 Key 字段：`id`、`key`（Tavily 真实 key，`tvly-` 开头）、`name/备注`、`status`（enabled/disabled）、`cooldown_until`（熔断冷却截止时间戳，默认空）。
- **请求派发策略（加权随机 + 熔断）**：
  1. 只从 `status=enabled` 且未处于冷却期（当前时间 > `cooldown_until`）的 key 中选取。
  2. 按"当日失败次数越少，被选中概率越高"做加权随机（当日失败为 0 的 key 权重最高）。
  3. 若某 key 在某段时间内连续失败达到阈值（例如连续失败 ≥ 5 次），自动给该 key 设置 `cooldown_until`（例如冷却 60 秒），冷却期内跳过它。
- **必须记录每个 Tavily Key 的每日统计**：当日成功次数、失败次数。
- **统计说明（重要）**：基于 KV 的并发特性，**该统计为"尽力而为的近似值"，允许少量误差，不做精确计数**；计数写入失败不影响主流程返回。
- **核心业务规则**：如果**没有任何可用的 Tavily key**（全部 disabled 或全部处于冷却期），则 `/search` 返回 `503 Service Unavailable`，并附明确错误信息。

### 三、分发 Key（对外开放的访问密钥）管理
- 用于授权给其他使用者调用搜索接口。
- 字段：`api_key`（随机生成，高熵，如 `sk-` + 随机串）、`备注`（必填，区分给谁）、`status`（enabled/disabled）、`created_at`。
- **不支持**配额限制、**不支持**过期时间。
- 操作：生成新 Key、单独删除某个 Key、启用/禁用。
- **明文 key 只显示一次**：生成时仅在生成成功的响应中返回一次明文，同时将该 key 标记为 `plain_viewed=true`；之后列表只显示脱敏形式（如 `sk-****`）。提供"重新查看明文"功能，但需管理员**二次输入密码确认**后才返回明文。
- **额外记录：每个分发 Key 的当日调用次数**（用于定位异常/泄露的 key；同样为近似值）。

### 四、对外 API（代理层）
- 只代理 **Tavily 搜索（Search）接口**。
- Endpoint：`POST /search`。
- 外部调用方通过 header `Authorization: Bearer <分发key>` 认证。
- **完整请求流程**：
  1. 取分发 key → 在 KV 查询 → 不存在或 `disabled` → 返回 `401`。
  2. 增加该分发 key 的当日调用计数。
  3. 按"加权随机 + 熔断"逻辑选一个可用 Tavily key；若无可用 → 返回 `503`。
  4. 将请求体转发给 Tavily `POST /search`（`https://api.tavily.com/search`），请求头换成选中的 Tavily key。
  5. **按响应结果分类处理并更新统计**：
     - **2xx** → 成功，该 Tavily key 当日成功数 +1，**原样返回 Tavily 响应**给调用方。
     - **429（上游限流）** → 不直接返回失败；**切换另一个可用 Tavily key 重试一次**；若重试仍 429，计入失败并返回 Tavily 的错误响应。
     - **401 / 403（key 无效/失效）** → 该 Tavily key 计入失败，并提示可通过管理后台标记该 key 为 `disabled`。
     - **其他 5xx / 网络错误** → 计入失败，透传 Tavily 的错误响应。
- **统计写入**：每个 Tavily key 的当日 `{success, fail}` 合并成**单次 KV PUT**（一个 key 存两个字段），减少写入次数；写入失败静默忽略，不阻塞主流程。
- Tavily 搜索接口参考：`POST https://api.tavily.com/search`，请求体含 `query`（必填）、`search_depth`、`include_answer`、`max_results`、`topic`、`include_domains` 等参数；认证 `Authorization: Bearer tvly-xxx`。请查阅 Tavily 官方文档确认完整参数。

### 五、管理后台页面（HTMX）
用 HTMX + 原生 HTML 实现两个区块的页面：

**区块 A：Tavily Keys 管理**
- 列表：显示所有 Tavily Key（key 需脱敏，如 `tvly-****`），含备注、状态、冷却状态、当日成功/失败次数。
- 操作：新增、删除、启用/禁用、编辑备注。
- 新增时**可对填入的 key 发起一次验证调用（test call）**，提示该 key 是否有效（可选功能）。
- 用 HTMX 局部刷新。

**区块 B：分发 Keys 管理**
- 列表：显示所有分发 key（key 需脱敏），含备注、状态、创建时间、当日调用次数。
- 操作：生成新 key（仅生成时显示一次明文）、删除、启用/禁用、重新查看明文（需二次密码确认）。
- 用 HTMX 局部刷新。

---

## KV 数据模型（建议）

```
# 所有数据存 KV，用带前缀的 key 区分

tavily_keys            → JSON 数组，存所有 Tavily Key 对象
distributed_keys       → JSON 数组，存所有分发 Key 对象

# 每日统计（带日期，跨天自然重置；统一按 Asia/Shanghai 时区取日期）
stats:{tavilyKeyId}:{YYYY-MM-DD}         → JSON { success, fail }
dist_stats:{distKeyId}:{YYYY-MM-DD}      → JSON { calls }
```

**时区约定**：每日"当天"统一按 **Asia/Shanghai** 时区计算日期字符串，跨天即视为新的统计日（同日归零，无需定时任务）。
**并发与精度**：KV 读-改-写存在竞态，统计值是近似值，允许误差；写失败静默忽略。

## 技术实现要点

1. **顺序执行**：按交付要求逐步实现。
2. **Wrangler secrets**：管理员密码用 `wrangler secret put ADMIN_PASSWORD`，代码读 `env.ADMIN_PASSWORD`。
3. **Worker 配置**：`wrangler.toml` 中配置 KV binding。
4. **安全**：
   - 管理后台所有写操作校验登录态 + CSRF token。
   - Cookie：`HttpOnly`、`SameSite=Lax`、会话 24h 过期。
   - 分发 key 和 Tavily key 在列表中一律脱敏；明文 key 不落日志。
   - 确保 KV namespace 权限不被无关用户访问（密钥明文存 KV，注意访问控制）。
5. **目录结构**（建议）：
   ```
   src/
     index.ts          # 入口，初始化 Hono app，路由注册
     auth.ts           # 管理员登录、会话、CSRF、登出
     kv.ts             # KV 数据访问封装（含统计、脱敏）
     proxy.ts          # /search 代理逻辑（鉴权→选key→转发→分类处理→统计）
     admin/
       tavily.ts       # Tavily Key 管理 API
       keys.ts         # 分发 Key 管理 API
     views/
       admin.html      # 管理后台模板(HTMX)
   wrangler.toml       # Worker + KV binding 配置
   ```

## 交付要求

请按以下顺序逐步实现，每步完成后再继续下一步：

1. **A. 项目脚手架**：初始化 Hono + TypeScript + Wrangler，配置 KV binding，跑通健康检查 `/` 接口。
2. **B. KV 数据层**：封装 Tavily Keys 和分发 Keys 的增删改查、状态切换、脱敏、每日统计（含跨天重置、近似值处理、单一 PUT）。
3. **C. 管理员认证**：实现密码登录、24h 会话 Cookie、CSRF、登出。
4. **D. 管理后台页面**：HTMX 实现 Tavily Keys 和分发 Keys 两个区块完整管理，含明文只显示一次、二次密码确认查看。
5. **E. 代理层**：实现 `POST /search`，Bearer 分发 key 校验 → 加权随机+熔断选 Tavily key → 转发 → 按 2xx/429/401/5xx 分类处理与统计 → 无可用 key 返回 503。

