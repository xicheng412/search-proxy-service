// 管理后台的 HTML 构建（原生 HTML + HTMX）。
// 本文件 = 公共脚手架（esc/csrfField/分页/nav/layout）+ 分发 Keys（provider 无关部分）；
// login 与 dashboard 页面模板分别在 views/login.ts 与 views/dashboard.ts。

import {
  Stats,
  DistributedKey,
  maskKey,
} from "../domain";
import { esc, csrfField } from "./html";
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
): string {
  const btn = (link: PaginationLink, label: string): string =>
    `<a class="page-btn" href="${esc(link.href)}" hx-get="${esc(link.hxGet)}" hx-target="${targetId}" hx-swap="innerHTML">${label}</a>`;
  const countText =
    total === null ? "" : ` · 共 ${total} 条`;
  const parts: string[] = [
    `<span class="muted">第 ${pagination.page} 页 · 每页 20 条${countText}</span>`,
  ];
  if (pagination.first && (pagination.page > 1 || !hasRows)) {
    parts.push(btn(pagination.first, "首页"));
  }
  if (pagination.previous) parts.push(btn(pagination.previous, "上一页"));
  if (pagination.next) parts.push(btn(pagination.next, "下一页"));
  return `<div class="pagination">${parts.join("")}</div>`;
}

type NavKey = "dashboard" | "tavily" | "exa" | "keys";

const NAV_ITEMS: { key: NavKey; href: string; label: string }[] = [
  { key: "dashboard", href: "/admin", label: "总览" },
  { key: "tavily", href: "/admin/tavily", label: "Tavily Keys" },
  { key: "exa", href: "/admin/exa", label: "Exa Keys" },
  { key: "keys", href: "/admin/keys", label: "分发 Keys" },
];

function nav(active: NavKey): string {
  return `<nav class="nav" aria-label="主导航">${NAV_ITEMS.map(
    (it) =>
      `<a class="nav-item${active === it.key ? " active" : ""}" href="${it.href}"${
        active === it.key ? ` aria-current="page"` : ""
      }>${it.label}</a>`
  ).join("")}</nav>`;
}

export function layout(
  title: string,
  body: string,
  opts: { header?: boolean; active?: NavKey; scripts?: string; bodyClass?: string } = {}
): string {
  const showHeader = opts.header !== false;
  const active = opts.active ?? "dashboard";
  const header = showHeader
    ? `<header class="topbar">
  <div class="topbar-inner">
    <a class="brand" href="/admin">
      <span class="brand-mark" aria-hidden="true"></span>
      <span class="brand-name">Tavily Proxy</span>
      <span class="brand-tag">Admin</span>
    </a>
    ${nav(active)}
    <div class="topbar-actions">
      <button class="icon-btn" type="button" data-theme-toggle aria-label="切换主题">
        <span class="theme-icon theme-icon-moon">${icon("moon")}</span>
        <span class="theme-icon theme-icon-sun">${icon("sun")}</span>
      </button>
      <a class="topbar-link" href="/help" target="_blank" rel="noopener">使用说明</a>
      <form method="post" action="/admin/logout">
        <button class="btn btn-ghost btn-sm" type="submit">登出</button>
      </form>
    </div>
  </div>
</header>`
    : "";
  return `<!doctype html>
<html lang="zh-CN">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <meta name="color-scheme" content="light dark">
  <title>${esc(title)}</title>
  <script>
  (function(){try{var t=localStorage.getItem("tp-theme");if(t!=="light"&&t!=="dark"){t=matchMedia("(prefers-color-scheme: dark)").matches?"dark":"light";}document.documentElement.dataset.theme=t;}catch(e){document.documentElement.dataset.theme="light";}})();
  </script>
  <link rel="stylesheet" href="/admin.css">
  <script src="https://unpkg.com/htmx.org@1.9.12"></script>
  <script src="/admin.js" defer></script>
</head>
<body${opts.bodyClass ? ` class="${esc(opts.bodyClass)}"` : ""}>
${header}
<main class="page">${body}</main>
<div id="toast-region" class="toast-region" aria-live="polite" aria-atomic="true"></div>
${opts.scripts ?? ""}
</body>
</html>`;
}

// ---------------------------------------------------------------
// 分发 Keys 独立管理页（provider 无关，公共部分）
// ---------------------------------------------------------------

export function keysPage(fragment: string): string {
  const body = `
${pageHeader({
  title: "分发 Keys",
  description: "生成、启停、删除分发 key；复制的是调用本服务的凭据。",
  actions: `<a class="btn btn-secondary btn-sm" href="#generate-key">${icon("plus")}生成 Key</a>`,
})}
${card({
  title: "Key 列表",
  description: "调用时用 Bearer tavily-<key> / exa-<key>（前缀决定路由）；官方真实 key 在上游 Keys 页管理。",
  body: `<div id="keys-list">${fragment}</div>`,
})}`;
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
): string {
  const flashHtml = toast(flash);
  const rows = keys.length
    ? keys
        .map((k) => {
          const st =
            k.status === "enabled"
              ? `<span class="badge badge-ok">enabled</span>`
              : `<span class="badge badge-neutral">disabled</span>`;
          const s = callsMap[k.api_key] ?? { success: 0, fail: 0 };
          return `<tr>
            <td><code class="key-mask">${esc(maskKey(k.api_key))}</code></td>
            <td>${esc(k.note)}</td>
            <td>${st}</td>
            <td class="muted" data-local-time data-epoch="${k.created_at}">${esc(new Date(k.created_at).toISOString().slice(0, 19).replace("T", " "))} UTC</td>
            <td class="num" title="该分发 key 最近24小时（15 分钟桶，含当前桶）的请求数">${s.success + s.fail}</td>
            <td class="cell-actions">
              <div class="row-actions">
                <div class="menu-wrap">
                  <button class="btn btn-ghost btn-sm" type="button" data-menu-toggle aria-haspopup="menu" aria-expanded="false" title="复制调用凭据">复制 ${icon("chevron-down")}</button>
                  <div class="menu" role="menu" hidden>
                    <button class="menu-item" type="button" role="menuitem" data-copy="tavily-${esc(k.api_key)}" title="复制调用凭据：Bearer tavily-&lt;key&gt;（请求走 Tavily）">复制 tavily 调用key</button>
                    <button class="menu-item" type="button" role="menuitem" data-copy="exa-${esc(k.api_key)}" title="复制调用凭据：Bearer exa-&lt;key&gt;（请求走 Exa）">复制 exa 调用key</button>
                    <button class="menu-item" type="button" role="menuitem" data-copy="searxng-tavily-${esc(k.api_key)}" title="复制调用凭据：Bearer searxng-tavily-&lt;key&gt;（SearXNG 协议，请求走 Tavily）">复制 searxng-tavily 调用key</button>
                    <button class="menu-item" type="button" role="menuitem" data-copy="reader-tavily-${esc(k.api_key)}" title="复制调用凭据：Bearer reader-tavily-&lt;key&gt;（reader 协议，URL→文本，走 Tavily Extract）">复制 reader-tavily 调用key</button>
                  </div>
                </div>
                <form hx-post="/admin/keys/${esc(k.api_key)}/toggle" hx-target="#keys-list"
                      hx-swap="innerHTML">
                  ${csrfField(csrf)}
                  <input type="hidden" name="back" value="${esc(selfQuery)}">
                  <button class="btn btn-ghost btn-sm" type="submit">${k.status === "enabled" ? "停用" : "启用"}</button>
                </form>
                <form hx-post="/admin/keys/${esc(k.api_key)}/delete" hx-target="#keys-list"
                      hx-swap="innerHTML" hx-confirm="确认删除该分发 key？">
                  ${csrfField(csrf)}
                  <input type="hidden" name="back" value="${esc(selfQuery)}">
                  <button class="btn btn-danger btn-sm" type="submit">删除</button>
                </form>
              </div>
            </td>
          </tr>`;
        })
        .join("")
    : emptyRow(6, "暂无分发 key，请先生成一个。");

  return `${flashHtml}
  <form id="generate-key" class="generate-row" hx-post="/admin/keys/generate" hx-target="#keys-list" hx-swap="innerHTML">
    ${csrfField(csrf)}
    <label class="field grow" for="key-note">
      <span class="field-label">备注</span>
      <input class="input" id="key-note" type="text" name="note" placeholder="给谁用（必填）" required>
    </label>
    <button class="btn btn-primary" type="submit">生成新 Key</button>
  </form>
  <div class="toolbar">
    <div class="toolbar-meta"><span class="muted">Base URL</span> <code class="mono">${esc(publicBaseUrl)}</code></div>
    <div class="cluster">
      <button class="btn btn-ghost btn-sm" type="button" data-copy="${esc(publicBaseUrl)}" title="复制调用基础地址">${icon("copy")}复制 base url</button>
      <button class="btn btn-ghost btn-sm" type="button" data-copy="${esc(publicBaseUrl + "/search")}" title="复制搜索端点：POST base/search">${icon("copy")}复制 /search</button>
    </div>
  </div>
  <div class="table-wrap">
    <table class="data-table">
      <thead><tr><th scope="col">Key</th><th scope="col">备注</th><th scope="col">状态</th><th scope="col">创建时间</th>
        <th scope="col" title="该分发 key 最近24小时（15 分钟桶，含当前桶）的请求数">最近24h请求</th><th scope="col">操作</th></tr></thead>
      <tbody>${rows}</tbody>
    </table>
  </div>
  ${paginationHtml(pagination, keys.length > 0, "#keys-list", total)}`;
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
): string {
  const box = `<div class="plain"><div class="plain-label">新 Key（只显示这一次）</div><code>${esc(plainApiKey)}</code></div>
<div class="card-note">新 key 是调用本服务的凭据（非外部服务 key）：请求时用 <code>Bearer tavily-${esc(plainApiKey)}</code>（走 Tavily）、<code>Bearer exa-${esc(plainApiKey)}</code>（走 Exa）、<code>Bearer searxng-tavily-${esc(plainApiKey)}</code>（SearXNG 协议，走 Tavily），或 <code>Bearer reader-tavily-${esc(plainApiKey)}</code>（reader 协议：GET /reader/&lt;url&gt; 拿页面文本，走 Tavily Extract）。</div>`;
  return box + distListFragment(keys, callsMap, csrf, pagination, undefined, publicBaseUrl, total, selfQuery);
}

/** 二次密码确认查看明文已随复制按钮移除（明文已注入行内，无需再查）。 */

export function errorFragment(msg: string): string {
  return `<div class="err">${esc(msg)}</div>`;
}

/** 一次性 flash 报文（内联 toast，非弹窗）；无消息时返回空串。 */
export function toast(flash?: string): string {
  return flash ? `<div class="toast">${esc(flash)}</div>` : "";
}
