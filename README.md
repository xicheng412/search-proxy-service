# tavily-cf-proxy

基于 **Hono** 构建，部署在 **Cloudflare Workers** 上的 API 密钥代理与管理平台：对外提供统一的 **Tavily / Exa** 搜索代理入口，将上游真实 API Key 收口在中间层，向下游分发可独立管控的访问 Key。

**概念区分（重要）**
- **上游服务 key（外部真实 key）**：Tavily / Exa 官方签发的 key，在后台 “Tavily Keys” / “Exa Keys” 页管理（列表脱敏），仅由本服务持有，转发时使用。
- **分发 key（调用凭据）**：纯随机字符串，在 “分发 Keys” 页生成。调用本服务时写成 `Bearer tavily-<分发key>` 或 `Bearer exa-<分发key>`，**前缀决定该次请求路由到哪个上游**；列表的 “复制 tavily/exa 调用key” 按钮复制的就是这种组装好的调用凭据，不是外部服务 key。

## 技术栈

- 框架：Hono（TypeScript）
- 运行时：Cloudflare Workers
- 部署 / CLI：Wrangler（V3+）
- 存储：Cloudflare Workers KV
- 管理后台：HTMX + 原生 HTML

## 目录结构

```
docs/
  plan.md              # 原始需求与交付计划
  exa-key-support.md   # Exa Key 管理与透明代理实施计划
src/
  index.ts             # 入口，初始化 Hono app，路由注册
  domain.ts            # 纯领域层：类型 + 前缀路由规则 + 值语义（零依赖）
  repo.ts              # 基础设施：KV 持久化 + 统计 + 熔断（依赖 domain）
  providers/           # 每 provider 一份描述符（tavily.ts / exa.ts）+ 注册表（防腐蚀层）
  proxy.ts             # 应用编排：鉴权 + 按请求前缀路由 + 加权选 key + 429 重试
  admin/               # 后台路由（tavily / exa / keys，按 provider 拆分）
  views/               # 后台模板（index 脚手架 / tavily / exa）
wrangler.toml          # Worker + KV binding 配置
```

> 完整需求与分工见 `docs/plan.md` 与 `docs/exa-key-support.md`。

## 本地开发

```bash
pnpm install
pnpm dev                 # wrangler dev，本地起 Worker
```

## 部署

1. 创建 KV namespace 并把生成的 id 填入 `wrangler.toml`：
   ```bash
   pnpm kv:create -- <PREFIX>
   ```
2. 配置管理员密码 secret：
   ```bash
   wrangler secret put ADMIN_PASSWORD
   ```
3. 部署：
   ```bash
   pnpm deploy
   ```
