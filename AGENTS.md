# Search Proxy Service

部署在 Cloudflare Workers 上的搜索 API 密钥代理：持有上游搜索服务（provider）的真实 key，向外签发可独立管控、可熔断的高熵 key，并统一线协议、重试与熔断策略。领域术语见 `CONTEXT.md`，实现见 `docs/architecture.md`。

This project uses pnpm.

## Boundary

Never commit real keys. 真实上游/分发 key 只存在于已 gitignore 的 `config/prod.env`、`.dev.vars`、`backup-online-kv.json`。

## Agent skills

### Issue tracker

GitHub issues via the `gh` CLI. See `docs/agents/issue-tracker.md`.

### Domain docs

Single-context: one `CONTEXT.md` plus `docs/adr/` at the repo root. See `docs/agents/domain.md`.
