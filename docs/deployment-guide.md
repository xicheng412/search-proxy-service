# 全新环境部署指南

本文档描述如何在**另一个全新的 Cloudflare 环境/账号** 上完整部署一套 tavily-cf-proxy(Worker + KV),从零到线上可用。

适用场景:换账号、换地区、或要与现有部署并存另开一套。

> 与已有部署共存时:若目标账号上已存在同名 worker,**会覆盖旧 worker**,需先改 `wrangler.toml` 的 `name`。

---

## 0. 前置条件

- Node.js 18+ 与 pnpm(pnpm 10 已验证)
- 一个 Cloudflare 账号
- 上游真实 API Key:Tavily(`tvly-` 开头)与/或 Exa

## 1. 获取代码并安装依赖

```bash
git clone <本仓库地址> tavily-cf-proxy
cd tavily-cf-proxy
pnpm install
```

注意事项:

- **pnpm 10** 会默认屏蔽依赖的构建脚本。仓库已在 `package.json` 的 `pnpm.onlyBuiltDependencies` 声明 `esbuild` / `workerd`,全新安装会自动放行并执行两个 postinstall。
- 若克隆前环境中残留过旧的本地 store 目录(如项目内 `.pnpm-store/`),`pnpm install` 可能报 `ERR_PNPM_UNEXPECTED_STORE`。解决:删除残留的 `.pnpm-store/` 后重新 `pnpm install`,改回使用全局 store。

**版本要求**:项目本地 wrangler 必须是 **v4+**(devDependency `^4.118.0`)。wrangler v3 已过时,对当前 Cloudflare API 部署会报 `fetch failed`。确认:

```bash
pnpm exec wrangler --version   # 应显示 4.x
```

## 2. 登录 Cloudflare

```bash
wrangler login
```

浏览器完成 OAuth 授权。确认已登录:

```bash
wrangler whoami
```

## 3. 创建 KV namespace

应用的所有数据(上游 key、分发 key、统计、会话)都存 KV,且**代码硬编码 binding 名为 `KV`**(`c.env.KV`),不能改名。

```bash
pnpm kv:create -- tavily-cf-proxy   # = wrangler kv namespace create tavily-cf-proxy
```

命令输出一个 namespace **id**,把它填进 `wrangler.toml`:

```toml
[[kv_namespaces]]
binding = "KV"
id = "<上一步生成的 id>"   # 替换
```

> `wrangler.toml` 里只有一个 KV binding,id 是资源标识符(非凭证),可提交。**不要提交任何真实 key / 密码。**

## 4. 配置管理员密码 secret

生产环境用 wrangler secret(存 Cloudflare,不进代码库):

```bash
wrangler secret put ADMIN_PASSWORD
```

代码从 `c.env.ADMIN_PASSWORD` 读取(`src/types.ts`)。**未配置时登录一律 401**(闭锁,无默认密码)。

本地开发可改用 `.dev.vars`(已 gitignore,不要提交):

```bash
# .dev.vars
ADMIN_PASSWORD=本地开发用密码
```

## 5. (可选)本地验证

```bash
pnpm dev
```

- 健康检查:`curl http://localhost:8787/` → `{"status":"ok",...}`
- 后台:`http://localhost:8787/admin` → 应 302 到 `/admin/login`,用 `.dev.vars` 的密码登录

## 6. 部署

```bash
pnpm run deploy:cf    # 等价于 wrangler deploy
```

> **不要用 `pnpm deploy`**:`deploy` 是 pnpm 保留命令,会报 `ERR_PNPM_CANNOT_DEPLOY`。

成功输出示例:

```
Uploaded tavily-cf-proxy
Deployed tavily-cf-proxy triggers
  https://tavily-cf-proxy.<你的子域>.workers.dev
Current Version ID: <hex>
```

## 7. 验证线上

```bash
# 健康检查
curl https://tavily-cf-proxy.<子域>.workers.dev/
# -> {"name":"tavily-cf-proxy","status":"ok","providers":["tavily","exa"],...}

# 后台鉴权门(未登录应 302 到登录页)
curl -i https://tavily-cf-proxy.<子域>.workers.dev/admin | head
```

浏览器打开 `/admin` 登录(用第 4 步的密码)。

## 8. 初始化数据(新环境 KV 是空的)

新环境 KV 不包含旧环境任何数据,需初始化:

1. **添加真实上游 key**:后台 → Tavily Keys / Exa Keys 页,录入真实 Tavily(`tvly-`) / Exa key(列表自动脱敏)。
2. **生成分发 key**:后台 → 分发 Keys 页,为每个调用方生成一条,拿到组装好的调用凭据 `Bearer tavily-<key>` / `Bearer exa-<key>`。
3. **冒烟调用**(端到端验证路由 + 透传):

```bash
curl -X POST https://tavily-cf-proxy.<子域>.workers.dev/search \
  -H "Authorization: Bearer tavily-<分发key>" \
  -H "Content-Type: application/json" \
  -d '{"query":"What is AI?"}'
```

> **数据迁移**:仓库没有内建的上游/分发 key 导出功能。若需要把旧环境的数据搬过来(而非重新录入),可用 `wrangler kv key list / key get / key put --binding=KV` 逐个导出倒入,注意这些数据含**真实上游 key**,迁移过程中需走安全通道。

## 9. 可选:绑定自有域名

默认使用 `*.workers.dev` 子域,无需操作。要绑自有域名:

- Dashboard → Workers → 选中 worker → Settings → Domains & Routes,或
- `wrangler routes` 命令

TLS 由 Cloudflare 自动签发。

## 10. 运行与排障

- **日志**:`wrangler.toml` 已开 `[observability.logs]`(invocation logs),Dashboard → Worker → Logs 实时查看。
- **实时 tail**:`wrangler tail`(调试线上请求)。
- **htmx**:后台页面从 `https://unpkg.com/htmx.org@1.9.12` CDN 加载,Worker 需能访问公网(CF Workers 默认允许),无需本地打包。

---

## 常见坑速查

| 现象 | 原因 | 解决 |
| --- | --- | --- |
| `ERR_PNPM_CANNOT_DEPLOY` | `pnpm deploy` 是保留命令 | 用 `pnpm run deploy:cf` |
| 部署报 `fetch failed` | 本地 wrangler v3 过时 | 升到 `^4.118.0` 后 `pnpm install` |
| `ERR_PNPM_UNEXPECTED_STORE` | node_modules 链接的本地 store 与全局冲突 | 删残留 `.pnpm-store/` 重装 |
| `Ignored build scripts: esbuild, workerd` | pnpm 10 默认屏蔽构建脚本 | `pnpm approve-builds` 或已由 `package.json` 声明 |
| 登录一直 401 | `ADMIN_PASSWORD` secret 未配置 | `wrangler secret put ADMIN_PASSWORD` |
| `/admin` 不跳登录页 | 已登录会话存在(cookie 24h) | 清除 `admin_session` cookie 或 `/admin/logout` |
| 数据为空 | 新环境 KV 独立,不随代码迁移 | 走第 8 步初始化/迁移 |
