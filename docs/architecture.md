# Architecture · 架构与设计

> 本文档面向"想理解代码 / 想改 / 想扩展 provider 的人"。
> 部署 / 跑起来 / 排错请看 [`deployment-guide.md`](./deployment-guide.md)。

---

## 1. 它到底是什么

`tavily-cf-proxy` 是一个部署在 **Cloudflare Workers** 上的 API 密钥代理与管理平台，向上游 **Tavily** 和 **Exa** 两个搜索 API 提供统一的代理入口。它的核心模式是 **"我自己持有上游 key，向外分发可独立管控的访问 key"**——这与 OpenAI / Anthropic 的对外 API key 分发语义同构。

- **代理链路**：外部用分发 key 调用 → 本服务校验 → 选上游 key → 透明转发 → 原样返回。
- **管理链路**：管理员密码登录后台 → 管理上游 key（多个，可加可删可熔断）/ 分发 key（生成、禁用、删除）/ 查看当日统计。

唯一对外数据面是 `POST /search`（同时是代理与文档约定的"主端点"），其他 `/admin/*` 是管理后台。

---

## 2. 核心概念区分（必读）

| 概念 | 形态 | 何时出现 | 备注 |
|---|---|---|---|
| **上游 key**（upstream key） | Tavily 的 `tvly-…` 或 Exa 的不规则字符串 | 后台 Tavily / Exa Keys 页录入 | 真实 key，由本服务持有；列表一律脱敏（如 `tvly-****`） |
| **分发 key**（distributed key） | 纯高熵 hex 字符串，无任何品牌前缀 | 后台 分发 Keys 页生成 | 用来给调用方；**调用时需拼前缀** `Bearer <provider>-<key>` |
| **provider 前缀** | `tavily` / `exa`（大小写不敏感） | 调用方发起请求时携带 | 决定这次请求路由到哪个上游；分发 key 自身**不带** provider 属性 |
| **当日** | `YYYY-MM-DD`（Asia/Shanghai 时区） | 跨天自然归零，零定时任务 | 见 [`src/domain.ts`](../src/domain.ts) `todayDate()` |
| **权重** | `1 / (当日失败数 + 1)` | 选上游 key 时计算 | 失败越少权重越高；0 失败最高 |

### 2.1 调用凭据的拼装规则

```
Authorization: Bearer <provider>-<key>
                        └─┬──┘ └─┬─┘
                  必须 tavily / exa   查库的 api_key（精确匹配）
```

- `parseDistKey()`（[`src/domain.ts`](../src/domain.ts)）按第一个 `-` 切分；分发 key 是 hex 不含 `-`，切分无歧义。
- 合法分发 key 用 `Bearer tavily-abc...` 走 Tavily，用 `Bearer exa-abc...` 走 Exa。
- **裸 key / `tvly-` 前缀 / `sk-` 前缀** 全部 401。
- 前缀决定路由后，错误响应格式按该 provider 的官方错误体返回（Tavily `{detail:{error}}`，Exa `{error}`）。

### 2.2 后台"复制"按钮语义

后台 分发 Keys 列表里每行有 **"复制 tavily 调用 key"** 和 **"复制 exa 调用 key"** 两个按钮——它们复制的是**组装好的调用凭据** `tavily-<key>` / `exa-<key>`，**不是** 外部服务 key。这是给"想让客户端用哪个 provider 调"准备的两种拼装结果。

---

## 3. 数据流

### 3.1 请求代理（`POST /search`）

```
┌──────────────┐
│ 调用方        │  Authorization: Bearer tavily-<key>  /  exa-<key>
└──────┬───────┘
       │
       ▼
┌──────────────────────────────────────────────────────┐
│ handleSearch (src/proxy.ts)                          │
│  ① authenticate:  parseDistKey → 查 distributed_keys │
│  ② recordDistCall: +1 当日调用（内存缓冲，节流 flush）│
│  ③ selectUpstreamKey:  从 enabled∧未冷却 中按权重选   │
│     ├─ 候选为空 → 503（provider 格式）               │
│  ④ proxyToUpstream:  Authorization 换成真实 key      │
│  ⑤ 分类处理:                                          │
│     - 2xx   → 记 success, 重置连续失败计数, 透传     │
│     - 429   → 切到另一个 key 重试一次                │
│              ├─ 重试仍 429 → 两 key 均记 fail, 透传 │
│              └─ 重试成功 → 走 2xx 路径               │
│     - 其他  → 记 fail, 触发熔断(若累计), 透传        │
└──────────────────────────────────────────────────────┘
       │
       ▼ (fetch 透传)
┌──────────────┐
│ Tavily / Exa │
└──────────────┘
```

### 3.2 管理后台（`/admin/*`）

```
GET /              → 302 /admin/login?next=...
POST /admin/login  → 校验 ADMIN_PASSWORD, setSession (HttpOnly, SameSite=Lax, secure, 24h)
GET  /admin        → Dashboard (Tavily/Exa/分发 key 统计卡 + 今日调用总数)
GET  /admin/tavily → Tavily Keys 列表 (HTMX 局部刷新)
GET  /admin/exa    → Exa Keys 列表
GET  /admin/keys   → 分发 Keys 列表
GET  /admin/help   → 使用说明 (含 curl 示例、错误表)
POST /admin/keys/generate  → 生成新分发 key, 明文只在响应里出现一次
POST /admin/{provider}/{id}/...  → 写操作, 都校验 CSRF
```

---

## 4. 模块分层（读代码请按此顺序）

```
┌─────────────────────────────────────────────────────────────────┐
│ domain.ts (纯领域)                                                │
│  类型 + parseDistKey 前缀路由规则 + 值语义 + 熔断常量            │
│  零依赖; storage/usage-store/circuit-breaker/proxy/admin/views   │
│  都只消费这里的词汇。                                             │
└─────────────────────────────────────────────────────────────────┘
                          ↑ ↑
┌────────────────────────┐ │ ┌──────────────────────────┐
│ storage.ts             │ │ │ providers/               │
│ KV 纯读写原语 +         │ │ │  tavily.ts / exa.ts      │
│ Keys 数组泛型 CRUD      │ │ │  + index.ts (注册表)     │
│ (依赖 domain)           │ │ │  防腐层, 新增 provider   │
│                        │ │ │  只加一份描述符           │
└────────────────────────┘ │ └──────────────────────────┘
         ↑ ↑              │            ↑ ↑
┌────────┴─┐ ┌────────────┴────┐ ┌─────┴──────────────────────┐
│ usage-   │ │ circuit-breaker │ │ proxy.ts (应用编排)          │
│ store.ts │ │ .ts             │ │ handleProviderProxy,        │
│ (日用量  │ │ (连续失败计数   │ │ selectUpstreamKey,           │
│  缓冲)  │ │  → 冷却 60s)   │ │ authenticate, classify       │
└─────────┘ └─────────────────┘ └──────────────────────────────┘
         ↑                                ↑
         │   ┌────────────────────────────┘
         │   │
┌────────┴───┴─────────────────────────────────────────────┐
│ index.ts (入口)  +  admin/  +  views/                    │
│  - 路由注册                                              │
│  - 鉴权中间件 (CSRF、登录态)                              │
│  - HTMX 渲染 (tavily/exa/keys 三块页面 + Dashboard + Help)│
└──────────────────────────────────────────────────────────┘
```

### 4.1 各模块职责一句话

| 模块 | 职责 | 不做什么 |
|---|---|---|
| `domain.ts` | 词汇 + 规则 + 纯函数 | 不 import 任何仓库模块；不读 KV |
| `storage.ts` | KV 读写 + Keys CRUD | 不做节流/不吞错/不写策略 |
| `usage-store.ts` | 内存累积 + 节流 flush + 读叠加 | 不改 domain 规则；不直接被 admin 写 |
| `circuit-breaker.ts` | 连续失败计数 → 冷却 | 不感知 provider；失败静默 |
| `providers/` | 一个 provider 的全部事实（base、endpoints、KV 键、id 前缀、test body、错误体格式） | 不写业务逻辑 |
| `proxy.ts` | 鉴权 + 选 key + 转发 + 分类处理 | 不读视图模板 |
| `auth.ts` | 登录 / 会话 / CSRF / 登出 | 不写业务数据 |
| `admin/` | 路由 + 鉴权校验 + 调 storage / usage-store | 不直接拼 HTML；视图在 views/ |
| `views/` | 模板片段（HTMX 友好）+ 渲染函数 | 不写 IO |
| `config.ts` | `PUBLIC_BASE_URL` 唯一取值点（缓存） | 不参与请求热路径 |
| `scripts/deploy.sh` | 注入 `PUBLIC_BASE_URL` → `wrangler deploy` | 不存任何真实域名 |

### 4.2 "新增 provider 需要改哪些文件"

按当前设计，**只需要两个文件**：

1. `src/providers/<name>.ts`：写一份 `ProviderConfig` 描述符（base / endpoints / upstream / admin / testBody / errorBody）。
2. `src/providers/index.ts`：把它注册到 `PROVIDERS`。

其余所有代码（proxy / storage / usage-store / admin / views）都消费 `PROVIDERS[name]`，无任何 `if (provider === "tavily")` 分支。

---

## 5. KV 数据模型

所有数据落在同一个 binding `KV`（硬编码，不能改名）。

```
tavily_keys                   → JSON 数组 (CoreKey[])
exa_keys                      → JSON 数组 (CoreKey[])
distributed_keys              → JSON 数组 (DistributedKey[])

session:<sid>                 → { expires_at, csrf, created_at }  (TTL = 24h)
stats:<upstreamKeyId>:<date>  → { success, fail }                 (TTL = 10 天)
dist_stats:<apiKey>:<date>    → { tavily, exa }                   (TTL = 10 天)
breaker:<upstreamKeyId>       → { consecutive }                   (TTL = 10 分钟)
```

| 设计点 | 决策 | 原因 |
|---|---|---|
| 上游 key 用 JSON 数组存 | 一份 PUT 全量写 | 列表量级小（< 100），简化原子性；不上索引 |
| 统计按日 + 写 TTL | 跨天自然归零 | 无定时任务，零维护成本 |
| 统计写失败静默 | 不阻塞主流程 | 见下方精度契约 |
| breaker TTL = 10 分钟 | 长时间无请求后连续失败计数自然过期 | 不依赖定时器 |

### 5.1 统计精度契约（重要）

`usage-store.ts` 实现的是**写回式近似统计**，不是精确计数：

- 同一 isolate 内 `record*` 后立即 `read*` 可见（本实例内存增量叠加）。
- 跨 isolate 最多延迟一个 flush 间隔（默认 5 秒）。
- isolate 被回收时未 flush 的增量丢失（≤ 一间隔量）。
- 写失败静默，读失败按 0 处理，**绝不阻塞主流程**。

这条契约对"选 key 权重"无影响（小幅误差反而让负载更均衡），仅影响"展示"和"异常 key 定位"的精度。

---

## 6. 关键行为规约

### 6.1 选上游 key

```ts
候选 = status == "enabled"  AND  (cooldown_until == null OR cooldown_until <= now)
权重 = 1 / (当日失败数 + 1)
按权重随机抽样
```

无可用 → `503`，错误体用该 provider 自己的格式。

### 6.2 冷却（双重）

- **Post-use 冷却**：每次使用后（无论成败）自动设置 5s 冷却，防止同一 key 被连续请求打穿。
- **熔断冷却**：非429失败 → 连续失败 +1，指数退避冷却 = max(5s, 60s × 2^consecutive)。
- 成功 → 连续失败归零，仅保留 5s post-use 冷却。
- 429 → 仅 post-use 5s 冷却，不碰连续失败计数。
- breaker 计数本身有 10 分钟 TTL——10 分钟内无新失败则视为"该 key 已恢复"。

### 6.3 自动重试

- 单次请求最多尝试 3 个不同的上游 key。
- 任何非2xx 或网络异常 → 换 key 重试。
- 每个失败 key 在重试过程中实时更新冷却，已冷却/禁用的 key 自动从候选池过滤。
- 候选池耗尽或达到 3 次上限 → 透传最后一个错误响应；无响应可得 → 502。
### 6.4 错误体格式

| provider | 错误响应 | 来源 |
|---|---|---|
| Tavily | `{ "detail": { "error": "..." } }` | 与官方一致 |
| Exa | `{ "error": "..." }` | 与官方一致（429 / 通用） |

`PROVIDERS[provider].errorBody(status, msg)` 集中产出，**禁止**在 proxy/admin 里硬编码某一家的格式。

### 6.5 会话与 CSRF

- Cookie `admin_session`：`HttpOnly` + `SameSite=Lax` + `secure` + 24h 过期。
- 写操作（POST /admin/*）一律校验 CSRF token（表单隐藏字段 `csrf_token`，恒定时间比较）。
- 页面 GET 未登录 → 302 `/admin/login?next=...`；其他请求未登录 → 401。
- `ADMIN_PASSWORD` 走 `wrangler secret`，代码里不出现明文；未配置时登录一律 401（闭锁，无默认密码）。

### 6.6 PUBLIC_BASE_URL

- **唯一取值点**：`src/config.ts` `resolvePublicBaseUrl()`，未配置 / 非法值回退 `http://localhost:8787`。
- 本地：`.dev.vars`（gitignore）。
- 线上：`config/prod.env`（gitignore），`scripts/deploy.sh` 以 `--var PUBLIC_BASE_URL:https://…` 注入（**冒号**，不是等号）。
- 仅用于后台"复制 base url / 复制 /search"按钮和 `/admin/help` 的 curl 示例，**`/search` 热路径不读**。

---

## 7. 目录结构

```
.
├── README.md              # 项目主页（英文）
├── docs/
│   ├── architecture.md    # 本文件
│   ├── deployment-guide.md# 全新环境部署（从零到线上）
│   ├── plan.md            # 项目原始需求（历史参考）
│   └── exa-key-support.md # Exa 集成参考（历史实施记录）
├── src/
│   ├── index.ts           # 入口：Hono app + 路由注册
│   ├── types.ts           # 共享类型：Env / AppVariables
│   ├── domain.ts          # 纯领域层（零依赖）
│   ├── storage.ts         # KV 持久化 + Keys 数组 CRUD
│   ├── usage-store.ts     # 日用量统计（写回式）
│   ├── circuit-breaker.ts # 熔断策略
│   ├── config.ts          # PUBLIC_BASE_URL 唯一取值
│   ├── auth.ts            # 登录 / 会话 / CSRF / 登出
│   ├── proxy.ts           # 应用编排：鉴权 + 选 key + 转发 + 分类
│   ├── providers/         # 防腐层：tavily.ts / exa.ts + 注册表
│   ├── admin/             # 后台路由：index.ts + tavily.ts + exa.ts + keys.ts
│   └── views/             # 后台模板：index.ts + tavily.ts + exa.ts
├── scripts/
│   └── deploy.sh          # 生产部署：注入 PUBLIC_BASE_URL 后 wrangler deploy
├── config/
│   ├── prod.env.example   # 模板（真实值填 gitignored 的 prod.env）
│   └── prod.env           # gitignored：生产 PUBLIC_BASE_URL
├── .dev.vars.example      # 模板（真实值填 gitignored 的 .dev.vars）
├── wrangler.toml          # Worker + KV binding + observability
├── tsconfig.json
└── package.json
```

---

## 8. 一些刻意的"不做"

- **不做 quota**：分发 key 不带配额/过期/限速字段；按需可加。
- **不做 SPA**：后台是 HTMX + 原生 HTML，CDN 加载 htmx，零构建步骤。
- **不做精确统计**：见 §5.1；这是一笔明确的复杂度交换。
- **不做 KV 索引**：上游 key / 分发 key 都用 JSON 数组；规模在两位数以下没意义。
- **不做迁移工具**：换账号时上游 key / 分发 key 都需要重新录入（见 deployment-guide §8）。
