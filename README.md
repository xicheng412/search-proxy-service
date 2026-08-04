# tavily-cf-proxy

基于 **Hono** 构建，部署在 **Cloudflare Workers** 上的 API 密钥代理与管理平台：对外提供统一的 **Tavily / Exa** 搜索代理入口，将上游真实 API Key 收口在中间层，向下游分发可独立管控的访问 Key。分发 Key 是**纯随机字符串**，请求时用 `Bearer tavily-<key>` 或 `Bearer exa-<key>` 携带，**前缀决定该次请求路由到哪个上游**。

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
  providers/           # 每 provider 一份描述符（tavily.ts / exa.ts）+ 注册表
  admin/               # 后台路由（tavily / exa / keys，按 provider 拆分）
  views/               # 后台模板（index 脚手架 / tavily / exa）
  kv.ts                # 泛型数据层（按 provider 描述符驱动）
  proxy.ts             # 泛型透明代理（按分发 key 的 provider 路由）
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
