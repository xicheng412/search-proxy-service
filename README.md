# tavily-cf-proxy

基于 **Hono** 构建，部署在 **Cloudflare Workers** 上的 API 密钥代理与管理平台：对外提供统一的 Tavily 搜索代理入口，将上游真实 API Key 收口在中间层，向下游分发可独立管控的访问 Key。

## 技术栈

- 框架：Hono（TypeScript）
- 运行时：Cloudflare Workers
- 部署 / CLI：Wrangler（V3+）
- 存储：Cloudflare Workers KV
- 管理后台：HTMX + 原生 HTML

## 目录结构

```
docs/
  plan.md        # 完整需求与交付计划
src/
  index.ts       # 入口，初始化 Hono app，路由注册
wrangler.toml    # Worker + KV binding 配置
```

> 更完整的目录结构规划见 `docs/plan.md`。

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
