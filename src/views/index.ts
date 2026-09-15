// 管理后台的 HTML 构建（原生 HTML + HTMX）。
// 本文件 = 公共脚手架（esc/csrfField/分页/nav/layout）+ 分发 Keys（provider 无关部分）；
// login 与 dashboard 页面模板分别在 views/login.ts 与 views/dashboard.ts。

import {
  DistStats,
  DistributedKey,
  maskKey,
} from "../domain";

export function esc(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

export function csrfField(token: string): string {
  return `<input type="hidden" name="csrf_token" value="${esc(token)}">`;
}

// ---------------------------------------------------------------
// 上游 Key 管理页分页（Tavily/Exa 共享）
// ---------------------------------------------------------------

export interface UpstreamPaginationLink {
  href: string;
  hxGet: string;
}

export interface UpstreamPagination {
  page: number;
  first: UpstreamPaginationLink | null;
  previous: UpstreamPaginationLink | null;
  next: UpstreamPaginationLink | null;
}

/**
 * 渲染列表下方的分页控件：
 * - 显示 `第 N 页 · 每页 20 条`。
 * - first/previous/next 为 null 时不渲染对应按钮；首页第一页不渲染"首页/上一页"。
 * - 空列表（hasRows=false）仍渲染唯一"首页"链接，恢复到无 cursor 的第一页。
 * - 每个链接同时带 href（完整页）与 hx-get（HTMX fragment），hx-target 指向对应列表容器。
 */
export function upstreamPaginationHtml(
  pagination: UpstreamPagination,
  hasRows: boolean,
  targetId: string
): string {
  const btn = (link: UpstreamPaginationLink, label: string): string =>
    `<a class="page-btn" href="${esc(link.href)}" hx-get="${esc(link.hxGet)}" hx-target="${targetId}" hx-swap="innerHTML">${label}</a>`;
  const parts: string[] = [
    `<span class="muted">第 ${pagination.page} 页 · 每页 20 条</span>`,
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
  return `<nav class="nav">${NAV_ITEMS.map(
    (it) =>
      `<a class="nav-item${active === it.key ? " active" : ""}" href="${it.href}">${it.label}</a>`
  ).join("")}</nav>`;
}

export function layout(
  title: string,
  body: string,
  opts: { header?: boolean; active?: NavKey; scripts?: string } = {}
): string {
  const showHeader = opts.header !== false;
  const active = opts.active ?? "dashboard";
  const header = showHeader
    ? `<header>
  <h1>Tavily Proxy · 管理后台</h1>
  ${nav(active)}
  <div class="header-actions">
    <a class="header-help" href="/help" target="_blank" rel="noopener">使用说明</a>
    <form method="post" action="/admin/logout" style="display:inline;">
      <button class="ghost" type="submit">登出</button>
    </form>
  </div>
</header>`
    : "";
  return `<!doctype html>
<html lang="zh-CN">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>${esc(title)}</title>
  <link rel="stylesheet" href="/admin.css">
  <script src="https://unpkg.com/htmx.org@1.9.12"></script>
  <script src="/admin.js" defer></script>
</head>
<body>
${header}
<main class="wrap">${body}</main>
${opts.scripts ?? ""}
</body>
</html>`;
}

// ---------------------------------------------------------------
// 分发 Keys 独立管理页（provider 无关，公共部分）
// ---------------------------------------------------------------

export function keysPage(csrf: string, fragment: string): string {
  const body = `
<section class="card">
  <h2>分发 Keys · 管理</h2>
  <p class="hint" style="margin:0 0 12px;">复制按钮复制的是<strong>调用本服务的凭据</strong> <code>Bearer tavily-&lt;key&gt;</code> / <code>Bearer exa-&lt;key&gt;</code>（前缀决定路由到 Tavily 还是 Exa），不是 Tavily/Exa 官方真实 key——官方 key 在 “Tavily Keys” / “Exa Keys” 页管理。</p>
  <div id="keys-list">${fragment}</div>
</section>
<input type="hidden" id="csrf" value="${esc(csrf)}">`;
  return layout("分发 Keys · Tavily Proxy", body, { active: "keys" });
}

// ---------------------------------------------------------------
// 分发 Keys 区块
// ---------------------------------------------------------------

export function distListFragment(
  keys: DistributedKey[],
  callsMap: Record<string, DistStats>,
  csrf: string,
  flash?: string,
  publicBaseUrl: string = ""
): string {
  const flashHtml = flash ? `<div class="toast" style="margin-bottom:8px;">${esc(flash)}</div>` : "";
  const rows = keys.length
    ? keys
        .map((k) => {
          const st =
            k.status === "enabled"
              ? `<span class="badge ok">enabled</span>`
              : `<span class="badge off">disabled</span>`;
          const s = callsMap[k.api_key] ?? { success: 0, fail: 0 };
          return `<tr>
            <td>${esc(maskKey(k.api_key))}</td>
            <td>${esc(k.note)}</td>
            <td>${st}</td>
            <td class="muted" data-local-time data-epoch="${k.created_at}">${esc(new Date(k.created_at).toISOString().slice(0, 19).replace("T", " "))} UTC</td>
            <td title="该分发 key 最近24小时（含当前小时）的请求数">${s.success + s.fail}</td>
            <td>
              <div class="hstack">
                <div class="menu-wrap">
                  <button class="ghost btn-sm" type="button" data-menu-toggle title="复制调用凭据">复制 ▾</button>
                  <div class="menu" hidden>
                    <button class="ghost" type="button" data-copy="tavily-${esc(k.api_key)}" title="复制调用凭据：Bearer tavily-&lt;key&gt;（请求走 Tavily）">复制 tavily 调用key</button>
                    <button class="ghost" type="button" data-copy="exa-${esc(k.api_key)}" title="复制调用凭据：Bearer exa-&lt;key&gt;（请求走 Exa）">复制 exa 调用key</button>
                    <button class="ghost" type="button" data-copy="searxng-tavily-${esc(k.api_key)}" title="复制调用凭据：Bearer searxng-tavily-&lt;key&gt;（SearXNG 协议，请求走 Tavily）">复制 searxng-tavily 调用key</button>
                    <button class="ghost" type="button" data-copy="reader-tavily-${esc(k.api_key)}" title="复制调用凭据：Bearer reader-tavily-&lt;key&gt;（reader 协议，URL→文本，走 Tavily Extract）">复制 reader-tavily 调用key</button>
                  </div>
                </div>
                <form hx-post="/admin/keys/${esc(k.api_key)}/toggle" hx-target="#keys-list"
                      hx-swap="innerHTML" style="display:inline-block;">
                  ${csrfField(csrf)}
                  <button class="ghost btn-sm" type="submit">${k.status === "enabled" ? "停用" : "启用"}</button>
                </form>
                <form hx-post="/admin/keys/${esc(k.api_key)}/delete" hx-target="#keys-list"
                      hx-swap="innerHTML" hx-confirm="确认删除该分发 key？" style="display:inline-block;">
                  ${csrfField(csrf)}
                  <button class="danger btn-sm" type="submit">删除</button>
                </form>
              </div>
            </td>
          </tr>`;
        })
        .join("")
    : `<tr><td colspan="6" class="muted">暂无分发 key，请先生成一个。</td></tr>`;

  return `${flashHtml}
  <form class="row" hx-post="/admin/keys/generate" hx-target="#keys-list" hx-swap="innerHTML">
    ${csrfField(csrf)}
    <input type="text" name="note" placeholder="备注（必填，给谁用）" required>
    <button type="submit">生成新 Key</button>
  </form>
  <div style="display:flex;justify-content:flex-end;align-items:center;gap:6px;margin:-4px 0 10px;">
    ${publicBaseUrl ? `<span class="muted" style="font-size:11px;">${esc(publicBaseUrl)}</span>` : ""}
    <button class="ghost btn-sm" type="button" data-copy="${esc(publicBaseUrl)}" title="复制调用基础地址">复制 base url</button>
    <button class="ghost btn-sm" type="button" data-copy="${esc(publicBaseUrl + "/search")}" title="复制搜索端点：POST base/search">复制 /search</button>
  </div>
  <table>
    <thead><tr><th>Key</th><th>备注</th><th>状态</th><th>创建时间</th>
      <th title="该分发 key 最近24小时（含当前小时）的请求数">最近24h调用</th><th>操作</th></tr>
    <tbody>${rows}</tbody>
  </table>`;
}

/** 生成成功：明文只显示这一次。返回的片段带明文框（含前缀用法提示）与刷新后的列表。 */
export function distGenerateResult(
  plainApiKey: string,
  keys: DistributedKey[],
  callsMap: Record<string, DistStats>,
  csrf: string,
  publicBaseUrl: string = ""
): string {
  const box = `<div class="plain">新 Key（请立即保存，只显示这一次）：<br>${esc(plainApiKey)}</div>
<div class="hint" style="margin-bottom:8px;">新 key 是<strong>调用本服务的凭据</strong>（非外部服务 key）：请求时用 <code>Bearer tavily-${esc(plainApiKey)}</code>（走 Tavily）、<code>Bearer exa-${esc(plainApiKey)}</code>（走 Exa）、<code>Bearer searxng-tavily-${esc(plainApiKey)}</code>（SearXNG 协议，走 Tavily），或 <code>Bearer reader-tavily-${esc(plainApiKey)}</code>（reader 协议：GET /reader/&lt;url&gt; 拿页面文本，走 Tavily Extract）。</div>`;
  return box + distListFragment(keys, callsMap, csrf, undefined, publicBaseUrl);
}

/** 二次密码确认查看明文已随复制按钮移除（明文已注入行内，无需再查）。 */

export function errorFragment(msg: string): string {
  return `<div class="err">${esc(msg)}</div>`;
}
