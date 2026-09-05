# Architecture · 架构与设计

> 本文档面向"想理解代码 / 想改 / 想扩展 provider 的人"。
> 部署 / 跑起来 / 排错请看 [`deployment-guide.md`](./deployment-guide.md)。

---

## 1. 它到底是什么

`tavily-cf-proxy` 是一个部署在 **Cloudflare Workers** 上的 API 密钥代理与管理平台，向上游 **Tavily** 和 **Exa** 两个搜索 API 提供统一的代理入口。它的核心模式是 **"我自己持有上游 key，向外分发可独立管控的访问 key"**——这与 OpenAI / Anthropic 的对外 API key 分发语义同构。

- **代理链路**：外部用分发 key 调用 → 本服务校验 → 按前缀路由选上游 → 进 provider 队列 DO 串行放行 → 选自带冷却的上游 key → 透明转发 → 原样返回。
- **管理链路**：管理员密码登录后台 → 管理上游 key（多个，可加可删可熔断）/ 分发 key（生成、禁用、删除）/ 查看当日统计与小时明细 / 运行时调三组参数（冷却、队列、鉴权缓存）。

唯一对外数据面是 `GET|POST /search`（同时是代理与文档约定的"主端点"）；`GET /` 返回服务信息 JSON；其余 `/admin/*` 是管理后台。

---

## 2. 概念与调用凭据

> 概念定义（上游 key / 分发 key / 线协议 / provider / 冷却 / 熔断 / 当日 / 小时桶…）见仓库根 [CONTEXT.md](../CONTEXT.md)——它是领域词汇唯一事实源，本文档不再重复定义，只写实现侧的拼装规则。

### 2.1 调用凭据的拼装规则

前缀同时决定**线协议**与**路由 provider**（复合前缀，大小写不敏感）：

```
Authorization: Bearer <proto?-><provider>-<key>
                        │                └─┬─┘
                        │              查库的 api_key（精确匹配）
                        └──────────────────┘
  tavily-<key>、exa-<key>                → proto=native (透传)
  searxng-tavily-<key>、searxng-exa-<key>→ proto=searxng (SearXNG 兼容协议)
```

- `parseDistKey()`（[`src/domain.ts`](../src/domain.ts)）按最后一个 `-` 切分；分发 key 是 hex 不含 `-`，切分无歧义。
- 合法分发 key 用 `Bearer tavily-abc...` 走 Tavily（透传），`Bearer exa-abc...` 走 Exa（透传），`Bearer searxng-tavily-abc...` 走 SearXNG 协议（后端 Tavily）。
- **裸 key / `tvly-` 前缀 / `sk-` 前缀 / 未注册的复合前缀** 全部 401。
- native 透传的错误响应用对应 provider 官方格式（Tavily `{detail:{error}}`，Exa `{error}`）；searxng 路径的错误统一为 `{ "error": "..." }`（见 §6.5）。

### 2.2 后台"复制"按钮语义

后台 分发 Keys 列表里每行有 **"复制 tavily 调用 key"**、**"复制 exa 调用 key"**、**"复制 searxng-tavily 调用 key"** 三个按钮——它们复制的是**组装好的调用凭据** `tavily-<key>` / `exa-<key>` / `searxng-tavily-<key>`，**不是** 外部服务 key。这是给"想让客户端用哪个协议+provider 调"准备的三种拼装结果。

---

## 3. 数据流

### 3.1 请求代理（`GET|POST /search`）

```
┌──────────────┐
│ 调用方        │  native:    Bearer tavily-<key> / exa-<key>   (POST)
│               │  searxng:   Bearer searxng-tavily-<key>       (GET|POST + q&format=json)
└──────┬───────┘
       ▼
┌──────────────────────────────────────────────────────┐
│ handleSearch (src/proxy.ts)                           │
│  ① authenticate：parseDistKey(协议+provider) → 查库    │
│  ② 打装任务（NativeTask / SearxngTask，见 queue-task） │
│  ③ forwardToQueue → QUEUE.idFromName(provider)        │
└──────────────────────────────────────────────────────┘
       ▼ (转发；若等待数 ≥ maxDepth → 429)
┌──────────────────────────────────────────────────────┐
│ QueueDO (src/queue.ts)  每 provider 一把               │
│  ④ 串行放行：一次只在途 1 任务，间隔 intervalMs        │
└──────────────────────────────────────────────────────┘
       ▼ (drain → runNativeTask / runSearxngTask)
┌──────────────────────────────────────────────────────┐
│ searchWithRetry (src/retry.ts) 重试状态机(FSM)        │
│  ⑤ recordDistCall（native 在核内记；searxng 路径也记） │
│  ⑥ selectUpstreamKey：从 enabled∧未冷却 按权重选       │
│     └─ 无 key / 全冷却 → 503（按协议错误体）           │
│  ⑦ fetch 上游（30s 超时, 每次换 key, 最多 3 次）       │
│  ⑧ 分类处理：                                          │
│     - 2xx   → 记 success, 重置连续失败, 协议响应       │
│     - 429   → 仅 post-use 冷却, 换 key 重试            │
│     - 400/404/422 → 立即返回, 不记失败不烧 key        │
│     - 401/403 → 记 fail + 疑似失效长冷却, 换 key      │
│     - 5xx/网络 → 记 fail + 指数退避, 换 key 重试      │
│  ⑨ 耗尽 → 透传最后错误 / 502（按协议错误体）           │
└──────────────────────────────────────────────────────┘
       │
       ▼ (fetch)
┌──────────────┐
│ Tavily / Exa │
└──────────────┘
```

### 3.2 管理后台（`/admin/*`）

```
GET  /                       → 302 /admin/login?next=...（页面）/ 401（API）
POST /admin/login            → 校验 ADMIN_PASSWORD, setSession (HttpOnly, SameSite=Lax, secure, 24h)
POST /admin/logout           → 销毁会话
GET  /admin                  → Dashboard（统计卡 + 三组运行时参数表单 / 定时清理说明）
GET  /admin/{tavily|exa}     → 上游 Keys 分页列表（HTMX 局部刷新）
GET  /admin/{tavily|exa}/list→ 列表片段（分页）
POST /admin/{tavily|exa}/add / add/batch   → 新增单个/批量上游 key（可选 test call）
POST /admin/{tavily|exa}/:id/name|toggle|delete → 改名/启停/删除
GET  /admin/keys             → 分发 Keys 列表（含复制按钮）
GET  /admin/keys/list        → 列表片段
POST /admin/keys/generate    → 生成新分发 key, 明文只在响应里出现一次
POST /admin/keys/:apiKey/toggle|delete → 启停/删除（撤销经鉴权缓存 ≤cacheTtlSec 生效）
POST /admin/breaker-config / queue-config / dist-cache-config → 写 KV 运行时参数（≤3s 生效）
GET  /admin/help             → 使用说明 (含 curl 示例、错误表)
```
所有写操作（POST）一律校验 CSRF；未经登录的页面 GET → 302 跳登录。

---

## 4. 模块分层（读代码请按此顺序）

```
┌─────────────────────────────────────────────────────────────────┐
│ domain.ts (纯领域)                                                │
│  类型 + parseDistKey 前缀路由规则(协议/provider) + 值语义          │
│  零依赖; 所有其它模块都只消费这里的词汇。                          │
└─────────────────────────────────────────────────────────────────┘
                          ↑ ↑
┌────────────────────────┐ │ ┌──────────────────────────┐
│ providers/             │ │ │ adapters/searxng.ts      │
│  tavily.ts / exa.ts +  │ │ │  协议转换（纯函数，不读   │
│  index.ts (注册表)     │ │ │  D1/KV）；proxy/queue 消费 │
│  防腐层, 新增 provider │ │ │                           │
│  只加一份描述符         │ │ └──────────────────────────┘
└────────────────────────┘ │
            ↑              │
┌───────────┴──────────────┴──────────────────────────┐
│ storage/  D1 实体读写                                  │
│  upstream-keys.ts (+ breaker_state) / dist-keys.ts    │
│  (+ Cache API 读缓存) / usage.ts / patch.ts           │
│  配置与会话走 KV（breaker-config / queue-config /      │
│  dist-cache-config / session:）                        │
└───────────┬───────────────────────────────────────────┘
            ↑
┌───────────┴───────────────────────────────────────────┐
│  usage-store.ts（内存缓冲 → 节流 flush → storage/usage）│
│  circuit-breaker.ts（熔断策略 → storage/upstream-keys）│
│  breaker-config.ts（冷却时长运行时参数, KV + TTL 缓存） │
└───────────┬───────────────────────────────────────────┘
            ↑
┌───────────┴───────────────────────────────────────────┐
│ retry.ts (FSM + 选 key + 上游传输)                     │
│  searchWithRetry / selectUpstreamKey / proxyToUpstream │
│ queue-task.ts (叶模块：NativeTask / SearxngTask)       │
└───────────┬───────────────────────────────────────────┘
            ↑
┌───────────┴───────────────────────────────────────────┐
│ proxy.ts (边界：鉴权 + 任务打装 + 队列转发 + 执行器)     │
│  handleSearch / authenticate / forwardToQueue /        │
│  runNativeTask / runSearxngTask                        │
└───────────┬───────────────────────────────────────────┘
            ↑  drain → 执行器
┌───────────┴────────────┐   ┌──────────────────────────┐
│ index.ts (入口)         │   │ QueueDO (queue.ts)       │
│  - 路由注册 /search      │   │  每 provider 一把, 串行   │
│  - scheduled 清理用量    │   │  放行 + maxDepth 拒入     │
└─────────────────────────┘   └──────────────────────────┘
         ↑
┌────────┴──────────────────────────────────────────────┐
│ admin/ + views/ + auth.ts + config.ts                   │
│  - 后台路由（tavily/exa/keys + Dashboard + Help）        │
│  - 登录会话 (KV) / CSRF                                  │
│  - HTMX 渲染；PUBLIC_BASE_URL 唯一取值                  │
└─────────────────────────────────────────────────────────┘
```

### 4.1 各模块职责一句话

| 模块 | 职责 | 不做什么 |
|---|---|---|
| `domain.ts` | 词汇 + 规则 + 纯函数 | 不 import 任何仓库模块；不读 KV/DB |
| `providers/` | 一个 provider 的全部事实（base、endpoints、上游键名、id 前缀、test body、错误体格式） | 不写业务逻辑 |
| `adapters/searxng.ts` | 消费方 ACL：searxng 参数→Tavily 请求体 / Tavily 响应→searxng JSON / searxng 错误体 | 不 import 仓库模块；不读 KV/DB |
| `storage/upstream-keys.ts` | 上游 key + 熔断状态（`breaker_state`）D1 读写 + keyset 分页 | 不做节流/不吞错/不写策略 |
| `storage/dist-keys.ts` | 分发 key D1 读写 + Cache API 鉴权读缓存（读穿 + 写失效） | 不写业务逻辑 |
| `storage/usage.ts` | 用量小时桶 D1 读写（UPSERT 求和 / 按窗口查询） | 不带内存缓冲（那是 usage-store 的活） |
| `usage-store.ts` | 内存累积 + 节流 flush + 读叠加（按 UTC 小时桶） | 不改 domain 规则；不直接被 admin 写 |
| `circuit-breaker.ts` | 连续失败计数 → 冷却（经 `breaker-config` 读运行时参数） | 不感知 provider；失败静默 |
| `breaker-config.ts` / `queue-config.ts` / `dist-cache-config.ts` | 读/写 KV 运行时参数（TTL 缓存，写后失效） | 不经手请求热路径 |
| `retry.ts` | 重试状态机（FSM）+ 选 key + 上游传输（`proxyToUpstream`，30s 超时） | 不接触 Hono Context；不含协议适配 |
| `queue-task.ts` | 队列任务 DTO（`NativeTask` / `SearxngTask`） | 零依赖叶模块，不读 KV/DB |
| `queue.ts` | `QueueDO`：每 provider 一把，串行放行 + `maxDepth` 拒入 | 不含鉴权；不含重试策略 |
| `proxy.ts` | 边界：鉴权 + 任务打装 + 队列转发 + native/searxng 执行器（经 retry 核 callbacks 注入） | 不含重试策略；不读视图模板 |
| `auth.ts` | 登录 / 会话（KV）/ CSRF / 登出 | 不写业务数据 |
| `admin/` | 路由 + 鉴权校验 + 调 storage / usage-store / 三组参数 | 不直接拼 HTML；视图在 views/ |
| `views/` | 模板片段（HTMX 友好）+ 渲染函数 | 不写 IO |
| `config.ts` | `PUBLIC_BASE_URL` 唯一取值点（缓存） | 不参与请求热路径 |
| `scripts/deploy.sh` | 注入 `PUBLIC_BASE_URL` → `wrangler deploy` | 不存任何真实域名 |

> `storage/` 泛型 CRUD 不写策略：**所有权收口在上层**——usage-store 决定"何时 flush / 静默"，circuit-breaker 决定"何时冷却"，proxy/queue 决定"何时转发、超时多久"。

### 4.2 "新增 provider 需要改哪些文件"

按当前设计，**只需要两个文件**：

1. `src/providers/<name>.ts`：写一份 `ProviderConfig` 描述符（base / endpoints / upstream / admin / testBody / errorBody）。
2. `src/providers/index.ts`：把它注册到 `PROVIDERS`。

其余所有代码（proxy / storage / usage-store / admin / views）都消费 `PROVIDERS[name]`，无任何 `if (provider === "tavily")` 分支。

> **协议与 provider 正交**：线协议（native / searxng）不是 provider，不需要走上面两文件。新增一个调用侧协议只需：注册复合前缀（`domain.ts:parseDistKey`）+ 在 `adapters/` 写纯转换函数 + 在 `proxy.ts` 加一条协议路径（经 `searchWithRetry` callbacks 注入）。例见 `searxng`。

---

## 5. 数据模型

两类存储，职责二分：

- **D1**（binding `DB`）：实体数据——上游 key、分发 key、用量小时桶、熔断状态。
- **KV**（binding `KV`）：运行时参数（`breaker_config` / `queue_config` / `dist_cache_config`）与登录会话（`session:<sid>`）。KV 上的 TTL 相当于 D1 迁移前留下的"零维护清理"习惯。

### 5.1 D1 表结构

```
upstream_keys(provider, id, key, name, status, cooldown_until, created_at)
              PK (provider, id); provider = 'tavily'|'exa'|未来
breaker_state(id, consecutive, updated_at, created_at)   -- 连续失败计数（1:1 上游 key）
distributed_keys(api_key, note, status, created_at)      -- PK api_key
usage_counts(kind, scope, provider, hour, success, fail) -- UTC 小时桶
              PK (kind, scope, provider, hour)
索引：idx_upstream_keys_provider_created_id (keyset 分页)
     idx_usage_scope_window (kind, scope, hour, provider)
     idx_usage_window        (kind, provider, hour)
```

| 设计点 | 决策 | 原因 |
|---|---|---|
| 实体上 D1，参数/会话留 KV | 实体改删查 + 分页强于 KV；参数要"≤3s 生效"且低写频，KV 正合适 | 各自用擅长的 |
| 上游 key 用表 + `(provider,id)` 主键 | provider 作维度字段，新增只加值 | 与 `providers/` 描述符对齐 |
| 用量按 UTC 小时桶 + 索引 | 热路径聚合一次往返（`SUM + GROUP BY`） | 见 §5.2 精度契约 |
| 熔断计数 1:1 存行 + `updated_at` | 10 分钟空窗用 `updated_at` 模拟 KV 的 TTL | 不依赖定时器；同批原子写冷却+计数 |
| 用量超 90 天清理 | `scheduled` cron（每天 UTC 03:00）删 `usage_counts` | D1 无 TTL，主动设保留期 |

> **分发 key 鉴权有 Cache API 快路径**：`storage/dist-keys.ts` 对 `getDistributedKey` 做读穿缓存（写操作失效），撤销/禁用的最坏生效延迟 = `dist_cache_config.cacheTtlSec`（默认 300s，可调）。

### 5.2 统计精度契约（重要）

`usage-store.ts` 实现的是**写回式近似统计**，不是精确计数：

- 同一 isolate 内 `record*` 后立即 `read*` 可见（本实例内存增量叠加）。
- 跨 isolate 最多延迟一个 flush 间隔（默认 5 秒）。
- isolate 被回收时未 flush 的增量丢失（≤ 一间隔量）。
- 写失败静默，读失败按 0 处理，**绝不阻塞主流程**。

这条契约对"选 key 权重"无影响（小幅误差反而让负载更均衡），仅影响"展示"和"异常 key 定位"的精度。精确度在这里是**显式、可消费的设计变量**——读侧优化的第一原则是"能近似就近似"，具体置换优先级见 §5.2.1。

#### 5.2.1 精度置换优先级（读侧优化决策规则）

**凡是统计类读取，统一不做精确计数**：先用精确度换查询次数，再用次数换往返，最后才优化扫描。

1. **用陈旧度换次数（第一优先，凡高频/热路径必选）**
   - 热路径选 key 权重只依赖 `本 isolate 内存增量 + 长效缓存 base`，接受分钟级（建议 1–5min）陈旧，**不发起 D1 往返**。误差方向是"比真实略旧的失败数"：刚出问题的 key 到下一轮刷新才被压低，对负载均衡是可接受甚至更稳的行为（§6.1 权重本就该贴近"最近大盘"而非"本瞬间"）。
   - 高频读一律挂缓存；缓存命中即 0 D1。**目标形态：代理热路径 0 次 D1 统计往返。**
2. **用次数换往返**：去不掉的读（展示类）保持低频；多批/多条查询用 `DB.batch()` 合并为一次往返；只 SELECT 消费方真正要的列与维度（例：选 key 只取 `SUM(fail)` + `GROUP BY scope`，不取 provider 拆分、不取 success）。
3. **最后才优化扫描（索引）**：D1 的单点瓶颈是"往返延迟 + 单库单线程吞吐"，不是行数（小时桶聚合后每 key 每日 ≤ 24 行）。不为 index-only scan 给 `usage_counts` 扩覆盖索引——写侧每 5s 全量 UPSERT，扩索引的写放大代价远大于省下的 heap 读。

**不进入置换范围**（精确语义，禁止近似）：
- 熔断 / 冷却状态（`breaker_state`、`cooldown_until`）：安全相关的放行决策，不许一秒误差。
- 鉴权、key 状态与任何硬约束。

---

## 6. 关键行为规约

### 6.1 选上游 key

```ts
候选 = status == "enabled"  AND  (cooldown_until == null OR cooldown_until <= now)
权重 = 1 / (当日失败数 + 1)
按权重随机抽样
```

无可用 → `503`，错误体用该 provider 自己的格式。

### 6.2 冷却（三层，共用一个字段）

- **Post-use 冷却**：每次使用后（无论成败）自动设置冷却（默认 10s），防止同一 key 被连续请求打穿。
- **熔断冷却**：非429失败 → 连续失败 +1，指数退避冷却 = max(post-use, base × 2^consecutive)，base 默认 10min。
- **疑似失效冷却**：401/403（key 级鉴权错误）→ 固定 `invalidCooldownSec`（默认 12h），不碰连续失败计数；到点重试一次，成功由 post-use 自动回缩。
- 成功 → 连续失败归零，仅保留 post-use 冷却。
- 429 → 仅 post-use 冷却，不碰连续失败计数。
- breaker 计数有 10 分钟空窗——10 分钟内无新失败（`updated_at` 落后超窗）则视为"该 key 已恢复"。
- **post-use / base / invalid 三个时长存 KV `breaker_config`，可在 admin dashboard"冷却参数"卡片运行时调整（≤3s 生效），无需重新部署**（见 `src/breaker-config.ts`）。

### 6.3 自动重试（`searchWithRetry` 核，位于 `src/retry.ts`）

- 单次请求最多尝试 3 个不同的上游 key（`MAX_ATTEMPTS`）。
- 每次尝试换 key；网络异常/超时（30s）视为失败并换 key。
- **分类语义**：
  - `2xx` → 协议处理（native 透传 / searxng 转 JSON）；searxng 解析失败视为失败换 key。
  - `429` → 仅 post-use 冷却，换 key 重试（不计熔断）。
  - `400/404/422` → 客户端确定性错误：立即返回，**不重试、不记失败、不烧 key**。
  - `401/403` → 记统计失败（权重惩罚）+ 疑似失效长冷却（默认12h，可调，不熔断），换 key。
  - 其他 `4xx`/`5xx` → 记录失败 + 指数退避冷却，换 key。
- 每个失败 key 在重试过程中实时更新冷却，已冷却/禁用的 key 自动从候选池过滤。
- 未配置任何上游 key / 全部冷却或禁用 → `503`（用 provider 错误体，searxng 用 `{error}`）。
- 候选池耗尽或达到 3 次上限 → 透传最后一个错误响应；无响应可得 → `502`。

#### 6.3.1 FSM 规约（声明式状态机）

实现是**声明式状态机**：状态（`init`/`pick`/`in-flight` + 终态）、扁平事件（`RetryEvent`，每个失败类一个 `kind`，无子分派）、迁移表（`TRANSITIONS`，key = `` `${state}:${kind}` ``，含可选 action）+ 少量行驱动器。读取进 `emit`、写副作用进迁移 action、请求级 bookkeeping 进 prologue。

```
init ──no-keys───────────────► no-keys           (终态=503)
  │   ──empty-candidates────► unavailable        (终态=503 全冷却/禁用)
  │   ──ready───────────────► pick
pick ──picked(key)──────────► in-flight
  │   ──depleted / guard(attempt≥MAX)──► exhausted   (终态)
in-flight ──success──[markSuccess]──────► success    (终态, 直接返回 res)
  │        ──unusable──[markFail]───────► pick       (2xx 但 onSuccess→null)
  │        ──network──[markFail]────────► pick       (fetch 异常/超时)
  │        ──rate-limit──[markRateLimit]► pick       (仅 post-use 冷却, 不记 usage)
  │        ──client-error───────────────► client-error (终态, 无副作用)
  │        ──auth-error──[markInvalid]──► pick       (记 fail + 疑似失效长冷却)
  │        ──server-error──[markFail]───► pick       (记 fail + 指数退避)

终态 ↔ RetryOutcome：success=res 直接返回；no-keys/unavailable/client-error/
exhausted → onFailure（透传最后响应或 503/502）。
```

**事件表（`RetryEvent`，12 个 kind）**

| kind | 触发 |
|---|---|
| `no-keys` | `init`：该 provider 未配置任何上游 key |
| `empty-candidates` | `init`：全部冷却/禁用 |
| `ready` | `init`：候选 ≥1，已读权重信号 |
| `picked key` | `pick`：选到可用 key |
| `depleted` | `pick`：候选池耗尽或 attempt ≥ MAX |
| `success res` | `in-flight`：2xx 且 onSuccess 产物非空 |
| `unusable res` | `in-flight`：2xx 但 onSuccess→null |
| `network` | `in-flight`：fetch 异常/超时 |
| `rate-limit res` | `in-flight`：429 |
| `client-error res` | `in-flight`：400/404/422 |
| `auth-error res` | `in-flight`：401/403 |
| `server-error res` | `in-flight`：其余（5xx/未知） |

**迁移表（`TRANSITIONS`，key = `` `${state}:${kind}` ``）**

| key | action | to |
|---|---|---|
| `init:no-keys` | — | `no-keys` |
| `init:empty-candidates` | — | `unavailable` |
| `init:ready` | — | `pick` |
| `pick:picked` | — | `in-flight` |
| `pick:depleted` | — | `exhausted` |
| `in-flight:success` | `markSuccess` 壳 | `success` |
| `in-flight:unusable` | `markFail` 壳 | `pick` |
| `in-flight:network` | `markFail` 壳 | `pick` |
| `in-flight:rate-limit` | `markRateLimit` 壳 | `pick` |
| `in-flight:client-error` | — | `client-error` |
| `in-flight:auth-error` | `markInvalid` 壳 | `pick` |
| `in-flight:server-error` | `markFail` 壳 | `pick` |

**上下文（`RetryContext`）**

| 字段 | 语义 |
|---|---|
| `env` / `def` / `request` / `cb` | 请求参数与依赖 |
| `store` / `hour` | usage 缓冲与当前小时桶 |
| `keys` / `statsMap` | 上游 key 列表与权重信号 |
| `tried` / `attempt` | 已试 key 集合 / 尝试计数 |
| `lastRes` | 最后一次错误响应（`exhausted` 透传） |
| `currentKey` | 本次在飞请求所用 key |

> `TRANSITIONS` / `emit` / `RetryState` / `RetryEvent` / `RetryContext` 为 **test-only 导出**（FSM 单测的唯一触达面）。usage/熔断持久态/队列 DO/协议渲染不进机器：写副作用在迁移 action，读在 `emit`，协议渲染经 `RetryCallbacks`（`cb`）访问；机器拥有执行/传输（transport 随核在此，避免 proxy↔retry 循环依赖）。

### 6.4 队列 DO（`src/queue.ts`）

每 provider 一把 `QueueDO`（`QUEUE.idFromName(provider)`），主 Worker 鉴权并打装任务后转发给它：

- **串行放行**：一次只在途 1 个任务，任务（含其内部重试）跑完后隔 `intervalMs`（默认 3s）再放下一个——削峰填谷，把上游请求频率压到可调区间。
- **maxDepth 拒入**：等待中任务数达到 `maxDepth`（默认 10）→ 新请求直接 `429`（拒入，不排队）。
- **容量门禁与入队原子**：check + push 在 Promise executor 同步段内完成，中间无 `await`，突发请求不会击穿 maxDepth。
- **连接断开**：任务仍未轮到（signal aborted）→ 直接丢弃，不烧上游配额。
- **任务内部重试不重新入队**：一个任务 = 一次"对上游的完整处理"（`searchWithRetry` 最多换 `MAX_ATTEMPTS` 把 key），重试试的是 key，不是重新排队。
- **参数运行时调整**：`intervalMs` / `maxDepth` 存 KV `queue_config`（见 `src/queue-config.ts`），改 KV 即生效（≤3s）。

### 6.5 错误体格式

| provider | 错误响应 | 来源 |
|---|---|---|
| Tavily | `{ "detail": { "error": "..." } }` | 与官方一致 |
| Exa | `{ "error": "..." }` | 与官方一致（429 / 通用） |
| SearXNG 协议 | `{ "error": "..." }` | 对齐 searxng `index_error` |

`PROVIDERS[provider].errorBody(status, msg)` 集中产出**上游官方错误体**；searxng 路径由 `adapters/searxng.ts:searxngError` 统一产出，**禁止**在 proxy/admin 里硬编码某一家的格式。

### 6.6 会话与 CSRF

- Cookie `admin_session`：`HttpOnly` + `SameSite=Lax` + `secure` + 24h 过期。
- 写操作（POST /admin/*）一律校验 CSRF token（表单隐藏字段 `csrf_token`，恒定时间比较）。
- 页面 GET 未登录 → 302 `/admin/login?next=...`；其他请求未登录 → 401。
- `ADMIN_PASSWORD` 走 `wrangler secret`，代码里不出现明文；未配置时登录一律 401（闭锁，无默认密码）。

### 6.7 PUBLIC_BASE_URL

- **唯一取值点**：`src/config.ts` `resolvePublicBaseUrl()`，未配置 / 非法值回退 `http://localhost:8787`。
- 本地：`.dev.vars`（gitignore）。
- 线上：`config/prod.env`（gitignore），`scripts/deploy.sh` 以 `--var PUBLIC_BASE_URL:https://…` 注入（**冒号**，不是等号）。
- 仅用于后台"复制 base url / 复制 /search"按钮和 `/admin/help` 的 curl 示例，**`/search` 热路径不读**。

---

## 7. 目录结构（按功能板块）

```
.
├── CONTEXT.md             # 领域词汇表（唯一事实源）
├── README.md / docs/      # 文档（architecture / deployment-guide / 历史参考）
├── src/
│   ├── index.ts           # 入口：路由注册 + scheduled 用量清理 + export QueueDO
│   ├── domain.ts          # 纯领域：类型、前缀路由规则、值语义（零依赖）
│   ├── 数据层             # storage/（D1 实体读写）+ usage-store.ts + 三个 config 模块
│   ├── 可靠性             # circuit-breaker.ts / retry.ts（FSM + 选 key + 传输）
│   ├── 调用面             # proxy.ts（边界）+ queue-task.ts（任务 DTO）+ queue.ts（QueueDO）
│   ├── 扩展点             # providers/（防腐层）+ adapters/（协议转换）
│   └── 管理面             # admin/ + views/（HTMX）+ auth.ts + config.ts
├── migrations/            # D1 迁移
├── scripts/deploy.sh      # 生产部署（注入 PUBLIC_BASE_URL）
├── config/ .dev.vars.example  # 环境配置（gitignored 真实值）
├── wrangler.toml          # Worker + KV/D1/QUEUE(DO) binding + cron + observability
└── package.json / tsconfig.json
```

> 各板块内文件分工见 §4 分层图与 §4.1 职责表——这里只给"改哪里找哪个板块"的入口。

---

## 8. 一些刻意的"不做"

- **不做 quota**：分发 key 不带配额/过期/限速字段；按需可加。
- **不做 SPA**：后台是 HTMX + 原生 HTML，CDN 加载 htmx，零构建步骤。
- **不做精确统计**：见 §5.2；这是一笔明确的复杂度交换。
- **不做迁移工具**：换账号时上游 key / 分发 key 都需要重新录入（见 deployment-guide §8）。
