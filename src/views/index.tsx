// 管理后台的 HTML 构建（Hono JSX + HTMX）。
// 本文件 = 公共脚手架（分页/nav/layout）+ 分发 Keys（provider 无关部分）；
// login 与 dashboard 页面模板分别在 views/login.tsx 与 views/dashboard.tsx。

import type { Child } from "hono/jsx";
import { raw } from "hono/html";
import {
  Stats,
  DistributedKey,
  maskKey,
} from "../domain";
import { csrfField } from "./html";
import { card, emptyRow, icon, pageHeader } from "./ui";

/**
 * 冷却剩余量的展示文案（Tavily/Exa 徽章共用；static/admin.js 的 cooldownText 保持逐字符一致）。
 * ≥100s → 「冷却：Nmin」（ceil 到整数分钟，估算值）；<100s → 「冷却：Ns」。
 * ms <= 0 返回 "-"，与列表空态一致。
 */
export function formatRemaining(ms: number): string {
  if (ms <= 0) return "-";
  if (Math.ceil(ms / 1000) >= 100) return `冷却：${Math.ceil(ms / 60_000)}min`;
  return `冷却：${Math.ceil(ms / 1_000)}s`;
}

// ---------------------------------------------------------------
// Key 管理页分页（Tavily/Exa 上游与分发 Keys 共享）
// ---------------------------------------------------------------

export interface PaginationLink {
  href: string;
  hxGet: string;
}

export interface Pagination {
  page: number;
  first: PaginationLink | null;
  previous: PaginationLink | null;
  next: PaginationLink | null;
}

/**
 * 渲染列表下方的分页控件：
 * - 显示 `第 N 页 · 每页 20 条`（total 非空时追加 ` · 共 N 条`）。
 * - first/previous/next 为 null 时不渲染对应按钮；首页第一页不渲染"首页/上一页"。
 * - 空列表（hasRows=false）仍渲染唯一"首页"链接，恢复到无 cursor 的第一页。
 * - 每个链接同时带 href（完整页）与 hx-get（HTMX fragment），hx-target 指向对应列表容器。
 */
export function paginationHtml(
  pagination: Pagination,
  hasRows: boolean,
  targetId: string,
  total: number | null = null
) {
  const btn = (link: PaginationLink, label: string) => (
    <a
      class="page-btn"
      href={link.href}
      hx-get={link.hxGet}
      hx-target={targetId}
      hx-swap="innerHTML"
    >
      {label}
    </a>
  );
  const countText = total === null ? "" : ` · 共 ${total} 条`;
  const parts: Child[] = [
    <span class="muted">
      第 {pagination.page} 页 · 每页 20 条{countText}
    </span>,
  ];
  if (pagination.first && (pagination.page > 1 || !hasRows)) {
    parts.push(btn(pagination.first, "首页"));
  }
  if (pagination.previous) parts.push(btn(pagination.previous, "上一页"));
  if (pagination.next) parts.push(btn(pagination.next, "下一页"));
  return <div class="pagination">{parts}</div>;
}

export type NavKey = "dashboard" | "tavily" | "exa" | "keys";

const NAV_ITEMS: { key: NavKey; href: string; label: string }[] = [
  { key: "dashboard", href: "/admin", label: "总览" },
  { key: "tavily", href: "/admin/tavily", label: "Tavily Keys" },
  { key: "exa", href: "/admin/exa", label: "Exa Keys" },
  { key: "keys", href: "/admin/keys", label: "分发 Keys" },
];

function nav(active: NavKey) {
  return (
    <nav class="nav" aria-label="主导航">
      {NAV_ITEMS.map((it) => (
        <a
          class={`nav-item${active === it.key ? " active" : ""}`}
          href={it.href}
          aria-current={active === it.key ? "page" : undefined}
        >
          {it.label}
        </a>
      ))}
    </nav>
  );
}

const THEME_SCRIPT = `(function(){try{var t=localStorage.getItem("tp-theme");if(t!=="light"&&t!=="dark"){t=matchMedia("(prefers-color-scheme: dark)").matches?"dark":"light";}document.documentElement.dataset.theme=t;}catch(e){document.documentElement.dataset.theme="light";}})();`;

export function layout(
  title: string,
  body: Child,
  opts: { header?: boolean; active?: NavKey; scripts?: Child; bodyClass?: string } = {}
) {
  const showHeader = opts.header !== false;
  const active = opts.active ?? "dashboard";
  const header = showHeader ? (
    <header class="topbar">
      <div class="topbar-inner">
        <a class="brand" href="/admin">
          <span class="brand-mark" aria-hidden="true"></span>
          <span class="brand-name">Tavily Proxy</span>
          <span class="brand-tag">Admin</span>
        </a>
        {nav(active)}
        <div class="topbar-actions">
          <button class="icon-btn" type="button" data-theme-toggle aria-label="切换主题">
            <span class="theme-icon theme-icon-moon">{icon("moon")}</span>
            <span class="theme-icon theme-icon-sun">{icon("sun")}</span>
          </button>
          <a class="topbar-link" href="/help" target="_blank" rel="noopener">
            使用说明
          </a>
          <form method="post" action="/admin/logout">
            <button class="btn btn-ghost btn-sm" type="submit">
              登出
            </button>
          </form>
        </div>
      </div>
    </header>
  ) : null;
  return (
    <>
      {raw("<!doctype html>")}
      <html lang="zh-CN">
        <head>
          <meta charset="utf-8" />
          <meta name="viewport" content="width=device-width, initial-scale=1" />
          <meta name="color-scheme" content="light dark" />
          <title>{title}</title>
          <script dangerouslySetInnerHTML={{ __html: THEME_SCRIPT }} />
          <link rel="stylesheet" href="/admin.css" />
          <script src="https://unpkg.com/htmx.org@1.9.12"></script>
          <script src="/admin.js" defer></script>
        </head>
        <body class={opts.bodyClass}>
          {header}
          <main class="page">{body}</main>
          <div
            id="toast-region"
            class="toast-region"
            aria-live="polite"
            aria-atomic="true"
          ></div>
          {opts.scripts}
        </body>
      </html>
    </>
  );
}

// ---------------------------------------------------------------
// 分发 Keys 独立管理页（provider 无关，公共部分）
// ---------------------------------------------------------------

export function keysPage(csrf: string, fragment: Child) {
  const body = (
    <>
      {pageHeader({
        title: "分发 Keys",
        description: "生成、启停、删除分发 key；复制的是调用本服务的凭据。",
        actions: (
          <a class="btn btn-secondary btn-sm" href="#generate-key">
            {icon("plus")}创建 Key
          </a>
        ),
      })}
      {card({
        title: "Key 列表",
        description:
          "调用时用 Bearer tavily-<key> / exa-<key>（前缀决定路由）；官方真实 key 在上游 Keys 页管理。",
        body: <div id="keys-list">{fragment}</div>,
      })}
      {card({
        id: "generate-key",
        title: "创建新的 Key",
        description: "备注用于区分使用者；明文只显示一次，生成后请立即复制。",
        body: (
          <>
            <form
              class="generate-row"
              hx-post="/admin/keys/generate"
              hx-target="#generate-result"
              hx-swap="innerHTML"
            >
              {csrfField(csrf)}
              <label class="field grow" for="key-note">
                <span class="field-label">备注</span>
                <input
                  class="input"
                  id="key-note"
                  type="text"
                  name="note"
                  placeholder="给谁用（必填）"
                  required
                />
              </label>
              <button class="btn btn-primary" type="submit">
                生成新 Key
              </button>
            </form>
            <div id="generate-result" class="generate-result" aria-live="polite"></div>
          </>
        ),
      })}
    </>
  );
  return layout("分发 Keys · Tavily Proxy", body, { active: "keys" });
}

// ---------------------------------------------------------------
// 分发 Keys 区块
// ---------------------------------------------------------------

export function distListFragment(
  keys: DistributedKey[],
  callsMap: Record<string, Stats>,
  csrf: string,
  pagination: Pagination,
  flash?: string,
  publicBaseUrl: string = "",
  total: number | null = null,
  selfQuery: string = "?page=1"
) {
  const rows: Child = keys.length
    ? keys.map((k) => {
        const st =
          k.status === "enabled" ? (
            <span class="badge badge-ok">enabled</span>
          ) : (
            <span class="badge badge-neutral">disabled</span>
          );
        const s = callsMap[k.api_key] ?? { success: 0, fail: 0 };
        return (
          <tr>
            <td>
              <code class="key-mask">{maskKey(k.api_key)}</code>
            </td>
            <td>{k.note}</td>
            <td>{st}</td>
            <td class="muted" data-local-time="" data-epoch={k.created_at}>
              {new Date(k.created_at).toISOString().slice(0, 19).replace("T", " ")} UTC
            </td>
            <td
              class="num"
              title="该分发 key 最近24小时（15 分钟桶，含当前桶）的请求数"
            >
              {s.success + s.fail}
            </td>
            <td class="cell-actions">
              <div class="row-actions">
                <div class="menu-wrap">
                  <button
                    class="btn btn-ghost btn-sm"
                    type="button"
                    data-menu-toggle
                    aria-haspopup="menu"
                    aria-expanded="false"
                    title="复制调用凭据"
                  >
                    复制 {icon("chevron-down")}
                  </button>
                  <div class="menu" role="menu" hidden>
                    <button
                      class="menu-item"
                      type="button"
                      role="menuitem"
                      data-copy={`tavily-${k.api_key}`}
                      title="复制调用凭据：Bearer tavily-<key>（请求走 Tavily）"
                    >
                      复制 tavily 调用key
                    </button>
                    <button
                      class="menu-item"
                      type="button"
                      role="menuitem"
                      data-copy={`exa-${k.api_key}`}
                      title="复制调用凭据：Bearer exa-<key>（请求走 Exa）"
                    >
                      复制 exa 调用key
                    </button>
                    <button
                      class="menu-item"
                      type="button"
                      role="menuitem"
                      data-copy={`searxng-tavily-${k.api_key}`}
                      title="复制调用凭据：Bearer searxng-tavily-<key>（SearXNG 协议，请求走 Tavily）"
                    >
                      复制 searxng-tavily 调用key
                    </button>
                    <button
                      class="menu-item"
                      type="button"
                      role="menuitem"
                      data-copy={`reader-tavily-${k.api_key}`}
                      title="复制调用凭据：Bearer reader-tavily-<key>（reader 协议，URL→文本，走 Tavily Extract）"
                    >
                      复制 reader-tavily 调用key
                    </button>
                  </div>
                </div>
                <form
                  hx-post={`/admin/keys/${k.api_key}/toggle`}
                  hx-target="#keys-list"
                  hx-swap="innerHTML"
                >
                  {csrfField(csrf)}
                  <input type="hidden" name="back" value={selfQuery} />
                  <button class="btn btn-ghost btn-sm" type="submit">
                    {k.status === "enabled" ? "停用" : "启用"}
                  </button>
                </form>
                <form
                  hx-post={`/admin/keys/${k.api_key}/delete`}
                  hx-target="#keys-list"
                  hx-swap="innerHTML"
                  hx-confirm="确认删除该分发 key？"
                >
                  {csrfField(csrf)}
                  <input type="hidden" name="back" value={selfQuery} />
                  <button class="btn btn-danger btn-sm" type="submit">
                    删除
                  </button>
                </form>
              </div>
            </td>
          </tr>
        );
      })
    : emptyRow(6, "暂无分发 key，请先生成一个。");

  return (
    <>
      {toast(flash)}
      <div class="toolbar">
        <div class="toolbar-meta">
          <span class="muted">Base URL</span> <code class="mono">{publicBaseUrl}</code>
        </div>
        <div class="cluster">
          <button
            class="btn btn-ghost btn-sm"
            type="button"
            data-copy={publicBaseUrl}
            title="复制调用基础地址"
          >
            {icon("copy")}复制 base url
          </button>
          <button
            class="btn btn-ghost btn-sm"
            type="button"
            data-copy={`${publicBaseUrl}/search`}
            title="复制搜索端点：POST base/search"
          >
            {icon("copy")}复制 /search
          </button>
        </div>
      </div>
      <div class="table-wrap">
        <table class="data-table">
          <thead>
            <tr>
              <th scope="col">Key</th>
              <th scope="col">备注</th>
              <th scope="col">状态</th>
              <th scope="col">创建时间</th>
              <th
                scope="col"
                title="该分发 key 最近24小时（15 分钟桶，含当前桶）的请求数"
              >
                最近24h请求
              </th>
              <th scope="col">操作</th>
            </tr>
          </thead>
          <tbody>{rows}</tbody>
        </table>
      </div>
      {paginationHtml(pagination, keys.length > 0, "#keys-list", total)}
    </>
  );
}

/** 生成成功：明文只显示这一次。返回的片段带明文框（含前缀用法提示）与刷新后的列表。 */
export function distGenerateResult(
  plainApiKey: string,
  keys: DistributedKey[],
  callsMap: Record<string, Stats>,
  csrf: string,
  pagination: Pagination,
  publicBaseUrl: string = "",
  total: number | null = null,
  selfQuery: string = "?page=1"
) {
  const box = (
    <>
      <div class="plain">
        <div class="plain-label">新 Key（只显示这一次）</div>
        <code>{plainApiKey}</code>
      </div>
      <div class="card-note">
        新 key 是调用本服务的凭据（非外部服务 key）：请求时用{" "}
        <code>Bearer tavily-{plainApiKey}</code>（走 Tavily）、
        <code>Bearer exa-{plainApiKey}</code>（走 Exa）、
        <code>Bearer searxng-tavily-{plainApiKey}</code>（SearXNG 协议，走 Tavily），或{" "}
        <code>Bearer reader-tavily-{plainApiKey}</code>
        （reader 协议：GET /reader/&lt;url&gt; 拿页面文本，走 Tavily Extract）。
      </div>
    </>
  );
  return (
    <>
      {box}
      <div id="keys-list" hx-swap-oob="innerHTML">
        {distListFragment(
          keys,
          callsMap,
          csrf,
          pagination,
          undefined,
          publicBaseUrl,
          total,
          selfQuery
        )}
      </div>
    </>
  );
}

/** 二次密码确认查看明文已随复制按钮移除（明文已注入行内，无需再查）。 */

export function errorFragment(msg: string) {
  return <div class="err">{msg}</div>;
}

/** 一次性 flash 报文（内联 toast，非弹窗）；无消息时不渲染。 */
export function toast(flash?: string) {
  return flash ? <div class="toast">{flash}</div> : null;
}
