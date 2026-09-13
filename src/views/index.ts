// 管理后台的 HTML 构建（原生 HTML + HTMX）。
// 本文件 = 公共脚手架 + 分发 Keys（provider 无关部分）；Tavily/Exa 各自的列表模板在
// views/tavily.ts 与 views/exa.ts（按其确认各维护一份）。

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

export function loginPage(error: boolean): string {
  const err = error
    ? `<p class="err">密码错误，请重试</p>`
    : "";
  const body = `<div style="max-width:360px;margin:120px auto;background:var(--card);
    border:1px solid var(--line);border-radius:12px;padding:24px;">
    <h1 style="font-size:18px;margin:0 0 16px;">Tavily Proxy 管理后台</h1>
    ${err}
    <form method="post" action="/admin/login">
      <label class="muted" style="font-size:13px;">管理员密码</label>
      <input type="password" name="password" autofocus autocomplete="current-password"
        style="margin:6px 0 12px;">
      <button type="submit" style="width:100%;">登录</button>
    </form>
  </div>`;
  return layout("登录 · Tavily Proxy", body, { header: false });
}

// ---------------------------------------------------------------
// Dashboard 总览页
// ---------------------------------------------------------------

export interface DashboardData {
  tavilyTotal: number;
  tavilyEnabled: number;
  exaTotal: number;
  exaEnabled: number;
  distTotal: number;
  distEnabled: number;
  distSeries: string;
  upstreamSeries: string;
  queueIntervalMs: number;
  queueMaxDepth: number;
  queueWaitBudgetMs: number;
  postUseCooldownSec: number;
  breakerBaseSec: number;
  invalidCooldownSec: number;
  distCacheTtlSec: number;
  csrf: string;
}

export function adminPage(data: DashboardData): string {
  const body = `
<section class="stats">
  <div class="card stat">
    <div class="stat-info">
      <div class="stat-name">Tavily Keys</div>
      <div class="stat-num">${data.tavilyTotal}</div>
      <div class="muted">启用 ${data.tavilyEnabled} · 停用 ${data.tavilyTotal - data.tavilyEnabled}</div>
    </div>
    <a class="btn" href="/admin/tavily">进入管理 →</a>
  </div>
  <div class="card stat">
    <div class="stat-info">
      <div class="stat-name">Exa Keys</div>
      <div class="stat-num">${data.exaTotal}</div>
      <div class="muted">启用 ${data.exaEnabled} · 停用 ${data.exaTotal - data.exaEnabled}</div>
    </div>
    <a class="btn" href="/admin/exa">进入管理 →</a>
  </div>
  <div class="card stat">
    <div class="stat-info">
      <div class="stat-name">分发 Keys</div>
      <div class="stat-num">${data.distTotal}</div>
      <div class="muted">启用 ${data.distEnabled} · 停用 ${data.distTotal - data.distEnabled}</div>
    </div>
    <a class="btn" href="/admin/keys">进入管理 →</a>
  </div>
</section>
<div class="dash-main">
  <div class="dash-rail">
    <div class="card stat">
      <div class="stat-label">最近 24h</div>
      <div class="stat-num" id="calls-24h">–</div>
    </div>
    <div class="card stat">
      <div class="stat-label">昨日</div>
      <div class="stat-num" id="calls-yesterday">–</div>
    </div>
    <div class="card stat">
      <div class="stat-label">今日</div>
      <div class="stat-num" id="calls-today">–</div>
    </div>
    <div class="dash-rail-foot">分发请求量 · 本地时区 · 今日含当前小时</div>
  </div>
  <div class="card chart">
    <h2 title="每个 UTC 小时桶内上游官方 key 的真实调用尝试次数，按 Tavily / Exa 拆两条线">近 5 天调用趋势 <span class="muted" style="font-size:11px;">（上游真实调用 Tavily/Exa）</span></h2>
    <div class="chart-box"><canvas id="calls-chart"></canvas></div>
  </div>
</div>
<section class="card">
  <h2>上游请求队列 · 参数</h2>
  <p class="hint" style="margin:0 0 12px;">突发请求会被串行放行到上游（Tavily / Exa 各自独立队列）：每个任务处理完隔 <strong>intervalMs</strong> 再放下一个；等待中达到 <strong>maxDepth</strong> 时新请求返回 429；排队等待超过 <strong>waitBudgetMs</strong> 也会直接 429。改这里即生效（≤3s 内），无需重新部署。想在放开频率时调大数值即可。</p>
  <form method="post" action="/admin/queue-config" class="row center">
    ${csrfField(data.csrf)}
    <label class="muted">间隔 (ms)</label>
    <input type="number" name="intervalMs" min="100" value="${data.queueIntervalMs}" required style="max-width:140px;">
    <label class="muted">最大等待数</label>
    <input type="number" name="maxDepth" min="1" value="${data.queueMaxDepth}" required style="max-width:140px;">
    <label class="muted">等待上限 (ms)</label>
    <input type="number" name="waitBudgetMs" min="1000" value="${data.queueWaitBudgetMs}" required style="max-width:140px;">
    <button type="submit" class="btn-sm">保存</button>
  </form>
</section>
<section class="card">
  <h2>冷却参数</h2>
  <p class="hint" style="margin:0 0 12px;"><strong>post-use</strong> 每次使用后（无论成败）的固定冷却；<strong>熔断</strong> 每次非 429 失败后指数退避 <code>base × 2^连续失败次数</code>；<strong>疑似失效</strong> 每次 401/403（key 级鉴权错误）后固定冷却，到点重试一次，成功自动恢复。三者在同一把 key 上取较久者生效。改这里即生效（≤3s 内），无需重新部署。</p>
  <form method="post" action="/admin/breaker-config" class="row center">
    ${csrfField(data.csrf)}
    <label class="muted">每次使用冷却 (秒)</label>
    <input type="number" name="postUseCooldownSec" min="0" step="1" value="${data.postUseCooldownSec}" required style="max-width:140px;">
    <label class="muted">熔断基数 (秒)</label>
    <input type="number" name="breakerBaseSec" min="1" step="1" value="${data.breakerBaseSec}" required style="max-width:140px;">
    <label class="muted">疑似失效 (秒)</label>
    <input type="number" name="invalidCooldownSec" min="1" step="1" value="${data.invalidCooldownSec}" required style="max-width:140px;">
    <button type="submit" class="btn-sm">保存</button>
  </form>
</section>
<section class="card">
  <h2>鉴权缓存参数</h2>
  <p class="hint" style="margin:0 0 12px;">分发 key 鉴权结果缓存在 Cache API 中，命中时无需读取 D1。缓存 TTL 越长，D1 读越少；禁用/删除后的最坏生效延迟也越长。写路径会主动失效缓存。改这里即生效（≤3s 内），无需重新部署。</p>
  <form method="post" action="/admin/dist-cache-config" class="row center">
    ${csrfField(data.csrf)}
    <label class="muted">鉴权缓存 TTL (秒)</label>
    <input type="number" name="cacheTtlSec" min="1" step="1" value="${data.distCacheTtlSec}" required style="max-width:140px;">
    <button type="submit" class="btn-sm">保存</button>
  </form>
</section>`;
  return layout("总览 · Tavily Proxy", body, {
    active: "dashboard",
    scripts: dashboardScript(data.distSeries, data.upstreamSeries),
  });
}

/**
 * Dashboard 图表脚本：注入 dist / upstream 两段序列 JSON（`\u003c` 转义防 `</script`），
 * 再按序引入 Chart.js CDN 与 static/dashboard.js——统计卡与趋势图的渲染逻辑已移入
 * 该文件，其 dataset 语义见 static/dashboard.js 顶部注释。
 * JSON 注入用 `\u003c` 而非 HTML esc：`<script>` 内容是 raw text，实体不反解码，
 * esc 把 `"` 变 `&quot;` 会破坏 JSON；`\u003c` 是合法 JSON 转义且防 `</script`/`<!--`。
 */
function dashboardScript(distSeriesJson: string, upstreamSeriesJson: string): string {
  return `<script type="application/json" id="dist-series">${distSeriesJson.replace(/</g, "\\u003c")}</script>
<script type="application/json" id="upstream-series">${upstreamSeriesJson.replace(/</g, "\\u003c")}</script>
<script src="https://cdn.jsdelivr.net/npm/chart.js@4.4.1/dist/chart.umd.min.js"></script>
<script src="/dashboard.js"></script>`;
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
