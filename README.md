# tavily-cf-proxy

> **A self-hosted API key proxy & management plane for Tavily and Exa, running on Cloudflare Workers.**
> 一款部署在 Cloudflare Workers 上的 Tavily / Exa 密钥代理与可视化管理平台（代理其 Search、Extract 等能力）：上游真实 key 收口在中间层，向下分发可独立管控的访问 key。

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

- **Multi-protocol, multi-provider, multi-capability.** `GET|POST /search` serves the **Search** ability (`Bearer tavily-…` native, `Bearer exa-…` native, or SearXNG-compatible `Bearer searxng-tavily-…`); `POST /extract` serves **Tavily Extract** (`Bearer tavily-…`). The prefix picks the provider, the endpoint picks the capability. Add a provider or capability with a descriptor file.
- **Tavily Extract passthrough.** `POST /extract` with `Bearer tavily-…` transparently forwards to Tavily Extract, sharing the exact same retry/breaker/usage-accounting pipeline as `/search` (native-only by design).
- **Weighted random + circuit breaker.** Among enabled, non-cooldown upstream keys, each is picked with weight `1 / (today's failures + 1)`. Three cooldown layers share one per-key field (whichever is longer wins): (1) post-use — every use gives a 10s cooldown; (2) breaker — non-429 failures escalate `10min × 2^consecutive_failures`, success resets the count; (3) suspected-invalid — `401/403` parks the key for 12h, auto-retried after. **All three cooldown params are runtime-adjustable** on the admin dashboard (defaults: 10s post-use, 10min breaker base, 12h invalid), stored in KV `breaker_config` — no redeploy needed.
- **Automatic retry with key rotation.** Request attempts up to 3 different upstream keys. Retry classification: `429` retries with post-use cooldown only; `400/404/422` client errors return immediately (no key burn); `401/403` park the key with a 12h suspected-invalid cooldown then switch; other failures / network errors trigger exponential cooldown and switch key. Tavily quota codes are handled without penalizing healthy keys: `432` (key/plan limit) retries like a rate-limit; `433` (PayGo limit) returns immediately with no retry/cooldown.
- **Native passthrough.** `tavily-` / `exa-` requests flow through untouched — request / response bodies pass verbatim; only the `Authorization` header is swapped — across both capability endpoints (`/search`, `/extract`).
- **SearXNG-compatible protocol adapter.** `searxng-tavily-<key>` speaks the standard SearXNG HTTP API (GET/POST query + `format=json`), translates to a Tavily Search request, reuses the same retry/circuit-breaker pipeline, and returns SearXNG-standard JSON (`query` / `results` / `answers` / `infoboxes` / `suggestions` / `unresponsive_engines`). Stats are still attributed to Tavily.
- **Distributed keys carry no provider binding.** One key; the prefix picks the provider — `tavily-<key>` for any Tavily capability (Search via `/search`, Extract via `/extract`), `exa-<key>` for Exa Search, `searxng-tavily-<key>` for Tavily Search via the SearXNG protocol. Operators choose at call time.
- **Best-effort per-day stats** for both upstream keys (success / fail) and distributed keys (call counts), shown live in the dashboard.
- **HTMX admin panel.** Session-based login (24h, HttpOnly, SameSite=Lax, CSRF-protected write paths), Tavily / Exa / Distributed Keys pages, dashboard, and a built-in usage help page with copy-able curl snippets. No SPA, no build.
- **Stateless deploy.** `pnpm install && pnpm dev` to run. Deploy is a single `pnpm run deploy:cf`.

## How it works

```
                    ┌──────────────────────────────────────────────┐
Caller ──────────►  │   /search  (Cloudflare Worker · Hono)         │
                    │                                              │
  Bearer tavily-…   │  1. parseDistKey → protocol (native|searxng)  │
  Bearer exa-…      │     + provider (tavily|exa)                   │
  Bearer searxng-…  │  2. lookup dist key in KV → 401 if missing    │
                    │  3. +1 today's call  (in-mem buffered)        │
                    │  4. searxng? translate  → Tavily request      │
                    │  5. pick upstream key (weighted, excludes      │
                    │     cooldown/disabled/tried keys)             │
                    │  6. proxy request (up to 3 attempts):         │
                    │     • 2xx      →  success + 10s post-use cool │
                    │     • 429      →  10s cool, switch key, retry │
                    │     • 400/404/422 → return now, no key burn   │
                    │     • 401/403   →  park key 12h, switch, retry│
                    │     • other 4xx/5xx/network → exp. cool, retry│
                    │  7. native: passthrough / searxng: → JSON     │
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
# Tavily Search（native 透传 /search）
curl -X POST http://localhost:8787/search \
  -H "Authorization: Bearer tavily-<your-distributed-key>" \
  -H "Content-Type: application/json" \
  -d '{"query": "What is Cloudflare Workers?"}'

# Exa Search（native 透传 /search，同一个 key 换前缀）
curl -X POST http://localhost:8787/search \
  -H "Authorization: Bearer exa-<your-distributed-key>" \
  -H "Content-Type: application/json" \
  -d '{"query": "What is Cloudflare Workers?"}'

# Tavily Extract（native 透传 /extract，仅 Tavily）
curl -X POST http://localhost:8787/extract \
  -H "Authorization: Bearer tavily-<your-distributed-key>" \
  -H "Content-Type: application/json" \
  -d '{"urls":["https://example.com"],"extract_depth":"basic"}'

# Tavily Search（searxng 协议，GET，SearXNG 标准 JSON 响应）
curl -L -X GET "http://localhost:8787/search?q=Cloudflare+Workers&format=json" \
  -H "Authorization: Bearer searxng-tavily-<your-distributed-key>"
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
├── storage.ts           # D1 entity layer (upstream/dist keys, usage hour buckets, breaker state)
├── usage-store.ts       # hour-bucket usage stats (write-back, in-memory buffering → D1)
├── circuit-breaker.ts   # cooldown: post-use + breaker + invalid (params runtime from KV)
├── breaker-config.ts    # runtime cooldown params (KV breaker_config, admin-adjustable)
├── auth.ts              # login / session / CSRF / logout
├── config.ts            # PUBLIC_BASE_URL single source of truth
├── proxy.ts             # auth → pick protocol path → retry core (up to 3x) → respond
├── adapters/            # consumer-side protocol ACL (searxng ↔ Tavily translation)
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

1. `src/providers/<name>.ts` — write a `ProviderConfig` (base url, capabilities, KV key, id prefix, admin path, test body, error-body formatter).
2. `src/providers/index.ts` — register it in `PROVIDERS`.

Storage, proxy, admin, and views all consume `PROVIDERS[name]`; there are no per-provider `if` branches in the shared code. See `docs/architecture.md §4.2` for the full walkthrough.

**Protocol adapters are orthogonal to providers.** A new *wire protocol* (like the SearXNG adapter in `src/adapters/`) does not require a new provider entry — it plugs into `searchWithRetry` via its own callbacks and only needs a new composite prefix registered in `domain.ts:parseDistKey` (e.g. `searxng-<provider>-`).

## License & status

Internal / private build. No public license is granted. If you fork this for your own use, the dependency choices (Hono, Cloudflare Workers, KV, HTMX) are all permissively licensed under their own terms.
