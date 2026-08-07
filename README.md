# tavily-cf-proxy

> **A self-hosted API key proxy & management plane for Tavily and Exa, running on Cloudflare Workers.**
> 一款部署在 Cloudflare Workers 上的 Tavily / Exa 搜索 API 密钥代理与可视化管理平台：上游真实 key 收口在中间层，向下分发可独立管控的访问 key。

[![Cloudflare Workers](https://img.shields.io/badge/Cloudflare-Workers-F38020?logo=cloudflare&logoColor=white)](#)
[![Hono](https://img.shields.io/badge/Hono-4.x-E36002?logo=hono&logoColor=white)](#)
[![TypeScript](https://img.shields.io/badge/TypeScript-5.7-3178C6?logo=typescript&logoColor=white)](#)
[![License](https://img.shields.io/badge/license-Internal-lightgrey)](#)
[![Status](https://img.shields.io/badge/status-private%20build-blueviolet)](#)

---

## Why

You hold real **Tavily** or **Exa** API keys for your team / customers, and you need:

- One unified entry point, but **two upstream providers** with different request / error shapes.
- **Isolated** distributed keys per consumer so you can revoke / rotate without touching upstream.
- Visibility into **who is calling what, how often, and which upstream key is hot or failing**.
- A way to **share** one upstream key budget across many callers without giving anyone the real key.

`tavily-cf-proxy` does exactly that — and runs on a free-tier Cloudflare Worker with one KV namespace. No servers, no DB, no build pipeline.

## Features

- **Multi-provider, single endpoint.** `POST /search` accepts either `Bearer tavily-…` or `Bearer exa-…`; the prefix decides routing. Add a new provider with a single descriptor file.
- **Weighted random + circuit breaker.** Among enabled, non-cooldown upstream keys, each is picked with weight `1 / (today's failures + 1)`. 5 consecutive failures → 60 s cooldown, auto-recover.
- **429 retry with key switching.** First 429 silently retries on a different upstream key (still transparent passthrough).
- **Transparent passthrough.** Request / response bodies flow through untouched; only the `Authorization` header is swapped.
- **Distributed keys carry no provider binding.** One generated key, two ways to call — `tavily-<key>` for Tavily, `exa-<key>` for Exa. Operators choose at call time.
- **Best-effort per-day stats** for both upstream keys (success / fail) and distributed keys (calls per provider), shown live in the dashboard.
- **HTMX admin panel.** Session-based login (24h, HttpOnly, SameSite=Lax, CSRF-protected write paths), Tavily / Exa / Distributed Keys pages, dashboard, and a built-in usage help page with copy-able curl snippets. No SPA, no build.
- **Stateless deploy.** `pnpm install && pnpm dev` to run. Deploy is a single `pnpm run deploy:cf`.

## How it works

```
                    ┌──────────────────────────────────────────────┐
Caller ──────────►  │   /search  (Cloudflare Worker · Hono)         │
                    │                                              │
  Bearer tavily-…   │  1. parseDistKey  →  provider                │
  Bearer exa-…      │  2. lookup dist key in KV  →  401 if missing  │
                    │  3. +1 today's call  (in-mem buffered)        │
                    │  4. pick upstream key  (weighted, no cooldown)│
                    │  5. proxy request, swap Authorization         │
                    │     • 2xx       →  record success, pass      │
                    │     • 429       →  retry once w/ other key    │
                    │     • other     →  record fail + breaker      │
                    └─────────────┬────────────────────────────────┘
                                  │  Bearer <real upstream key>
                                  ▼
                        ┌─────────────────────┐
                        │  api.tavily.com     │
                        │  api.exa.ai         │
                        └─────────────────────┘
```

The same Worker also serves `/admin/*` for the management plane. See [`docs/architecture.md`](./docs/architecture.md) for the full module map and data model.

## Quick start

Prerequisites: **Node.js 18+** and **pnpm 10+**, plus a Cloudflare account.

```bash
# 1. install
git clone <your-fork-url> tavily-cf-proxy
cd tavily-cf-proxy
pnpm install

# 2. configure local secrets
cp .dev.vars.example .dev.vars
# edit .dev.vars → ADMIN_PASSWORD=anything, PUBLIC_BASE_URL=http://localhost:8787

# 3. run
pnpm dev
# → http://localhost:8787  (health: GET /)
# → http://localhost:8787/admin  (login with ADMIN_PASSWORD)
```

Log into the admin panel, add at least one upstream key under **Tavily Keys** or **Exa Keys**, then generate a distributed key under **Distributed Keys** and call:

```bash
# Tavily path
curl -X POST http://localhost:8787/search \
  -H "Authorization: Bearer tavily-<your-distributed-key>" \
  -H "Content-Type: application/json" \
  -d '{"query": "What is Cloudflare Workers?"}'

# Exa path (same key, different prefix)
curl -X POST http://localhost:8787/search \
  -H "Authorization: Bearer exa-<your-distributed-key>" \
  -H "Content-Type: application/json" \
  -d '{"query": "What is Cloudflare Workers?"}'
```

## Deploy to production

```bash
# 1. one-time: create the KV namespace, paste the id into wrangler.toml
pnpm kv:create -- tavily-cf-proxy

# 2. one-time: set the admin password as a secret
wrangler secret put ADMIN_PASSWORD

# 3. one-time: set the public base url (kept gitignored)
cp config/prod.env.example config/prod.env
# edit config/prod.env → PUBLIC_BASE_URL=https://your.domain

# 4. deploy
pnpm run deploy:cf    # NOT `pnpm deploy` (pnpm reserved command)
```

Full step-by-step (new Cloudflare account, custom domain, troubleshooting) is in [`docs/deployment-guide.md`](./docs/deployment-guide.md).

## Tech stack

| Layer | Choice |
|---|---|
| Runtime | Cloudflare Workers (V8 isolates) |
| Framework | [Hono](https://hono.dev/) 4.x |
| Language | TypeScript 5.7 (strict) |
| Storage | Cloudflare Workers KV |
| Admin UI | HTMX 1.9 + native HTML (no SPA, no bundler) |
| CLI | Wrangler 4.x |

## Project layout

```
src/
├── index.ts             # Hono app + routes
├── domain.ts            # pure domain: types, parseDistKey, value semantics
├── storage.ts           # KV primitives + generic Keys CRUD
├── usage-store.ts       # per-day stats (write-back, in-memory buffering)
├── circuit-breaker.ts   # consecutive-failure → cooldown
├── auth.ts              # login / session / CSRF / logout
├── config.ts            # PUBLIC_BASE_URL single source of truth
├── proxy.ts             # auth → select key → forward → classify
├── providers/           # one descriptor per upstream (tavily / exa / index)
├── admin/               # /admin/* routes (per-provider files + shared)
└── views/               # HTMX templates
```

Full directory + per-file responsibilities are in [`docs/architecture.md`](./docs/architecture.md).

## Documentation

| Doc | Purpose |
|---|---|
| [`docs/architecture.md`](./docs/architecture.md) | Concept distinctions, module layers, data model, behavior specs, "how to add a provider" |
| [`docs/deployment-guide.md`](./docs/deployment-guide.md) | Fresh-environment deploy (login, KV, secrets, custom domain, troubleshooting) |
| [`docs/plan.md`](./docs/plan.md) | Original requirements + delivery plan (historical reference) |
| [`docs/exa-key-support.md`](./docs/exa-key-support.md) | Exa integration design notes (historical reference) |

In-app: the admin panel has a built-in **Help** page at `/admin/help` with copyable curl examples and the error-response table.

## Adding a new upstream provider

Two files, no logic changes:

1. `src/providers/<name>.ts` — write a `ProviderConfig` (base url, endpoints, KV key, id prefix, admin path, test body, error-body formatter).
2. `src/providers/index.ts` — register it in `PROVIDERS`.

Storage, proxy, admin, and views all consume `PROVIDERS[name]`; there are no per-provider `if` branches in the shared code. See `docs/architecture.md §4.2` for the full walkthrough.

## License & status

Internal / private build. No public license is granted. If you fork this for your own use, the dependency choices (Hono, Cloudflare Workers, KV, HTMX) are all permissively licensed under their own terms.
