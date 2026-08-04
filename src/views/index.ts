// 管理后台的 HTML 构建（原生 HTML + HTMX）。
// 本文件 = 公共脚手架 + 分发 Keys（provider 无关部分）；Tavily/Exa 各自的列表模板在
// views/tavily.ts 与 views/exa.ts（按其确认各维护一份）。

import {
  DistStats,
  DistributedKey,
  maskKey,
} from "../kv";

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
  opts: { header?: boolean; active?: NavKey } = {}
): string {
  const showHeader = opts.header !== false;
  const active = opts.active ?? "dashboard";
  const header = showHeader
    ? `<header>
  <h1>Tavily Proxy · 管理后台</h1>
  ${nav(active)}
  <form method="post" action="/admin/logout" style="display:inline;">
    <button class="ghost" type="submit">登出</button>
  </form>
</header>`
    : "";
  return `<!doctype html>
<html lang="zh-CN">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>${esc(title)}</title>
  <script src="https://unpkg.com/htmx.org@1.9.12"></script>
  <script>
    // 一键复制：点击带 data-copy 的按钮，把完整 key 复制到剪贴板
    document.addEventListener('click', function (e) {
      var btn = e.target && e.target.closest ? e.target.closest('[data-copy]') : null;
      if (!btn) return;
      var text = btn.getAttribute('data-copy') || '';
      if (!text) return;
      var orig = btn.textContent;
      navigator.clipboard.writeText(text).then(function () {
        btn.textContent = '已复制';
        setTimeout(function () { btn.textContent = orig; }, 1200);
      }).catch(function () {
        btn.textContent = '复制失败';
        setTimeout(function () { btn.textContent = orig; }, 1200);
      });
    });
  </script>
  <style>
    :root { --bg:#0f172a; --card:#1e293b; --line:#334155; --txt:#e2e8f0;
            --muted:#94a3b8; --accent:#38bdf8; --ok:#4ade80; --bad:#f87171; }
    * { box-sizing:border-box; }
    body { margin:0; font-family:system-ui,-apple-system,Segoe UI,Roboto,sans-serif;
           background:var(--bg); color:var(--txt); }
    header { padding:16px 24px; border-bottom:1px solid var(--line);
             display:flex; justify-content:space-between; align-items:center; gap:16px;
             flex-wrap:wrap; }
    header h1 { font-size:18px; margin:0; }
    .nav { display:flex; gap:4px; flex-wrap:wrap; }
    .nav-item { padding:6px 14px; border-radius:8px; text-decoration:none;
                color:var(--muted); font-size:14px; }
    .nav-item:hover { color:var(--txt); background:var(--card); }
    .nav-item.active { color:#04121f; background:var(--accent); font-weight:600; }
    .wrap { max-width:1180px; margin:0 auto; padding:24px; }
    .stats { display:grid; grid-template-columns:repeat(auto-fit,minmax(240px,1fr));
             gap:20px; margin-bottom:20px; }
    .card { background:var(--card); border:1px solid var(--line);
            border-radius:12px; padding:16px; }
    .card h2 { font-size:15px; margin:0 0 12px; color:var(--accent); }
    .stat .stat-num { font-size:40px; font-weight:700; line-height:1; margin:8px 0 12px;
                      color:var(--txt); }
    .stat .muted { margin-bottom:16px; }
    .btn { display:inline-block; padding:8px 14px; border-radius:8px; text-decoration:none;
           background:var(--accent); color:#04121f; font-weight:600; font-size:14px; }
    .btn:hover { filter:brightness(1.08); }
    table { width:100%; border-collapse:collapse; font-size:13px; }
    th,td { text-align:left; padding:8px 6px; }
    thead th { border-bottom:1px solid var(--line); }
    th { color:var(--muted); font-weight:600; }
    .muted{ color:var(--muted); }
    .badge{ display:inline-block; padding:2px 8px; border-radius:999px; font-size:11px; }
    .badge.ok{ background:#052e16; color:var(--ok); }
    .badge.off{ background:#3f1d1d; color:var(--bad); }
    .badge.warn{ background:#33300a; color:#facc15; }
    input[type=text],input[type=password] { background:#0f172a; color:var(--txt);
      border:1px solid var(--line); border-radius:8px; padding:8px 10px; width:100%; }
    button { background:var(--accent); color:#04121f; border:0; border-radius:8px;
      padding:8px 14px; font-weight:600; cursor:pointer; }
    button.ghost { background:transparent; color:var(--muted); border:1px solid var(--line); }
    button.danger { background:#7f1d1d; color:#fecaca; }
    form.row { display:flex; gap:8px; margin-bottom:12px; flex-wrap:wrap; }
    form.row input { flex:1; }
    .hint{ font-size:11px; color:var(--muted); margin-top:6px; }
    .plain{ background:#052e16; border:1px solid var(--ok); color:var(--ok);
      border-radius:8px; padding:10px 12px; word-break:break-all;
      font-family:ui-monospace,Menlo,monospace; margin-bottom:8px; }
    .err{ color:var(--bad); }
    .toast{ background:#164e63; padding:6px 10px; border-radius:8px; font-size:12px; }
    a{ color:var(--accent); }
  </style>
</head>
<body>
${header}
<main class="wrap">${body}</main>
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
  todayCalls: number;
  today: string;
}

export function adminPage(data: DashboardData): string {
  const body = `
<section class="stats">
  <div class="card stat">
    <h2>Tavily Keys</h2>
    <div class="stat-num">${data.tavilyTotal}</div>
    <div class="muted">启用 ${data.tavilyEnabled} · 停用 ${data.tavilyTotal - data.tavilyEnabled}</div>
    <a class="btn" href="/admin/tavily">进入管理 →</a>
  </div>
  <div class="card stat">
    <h2>Exa Keys</h2>
    <div class="stat-num">${data.exaTotal}</div>
    <div class="muted">启用 ${data.exaEnabled} · 停用 ${data.exaTotal - data.exaEnabled}</div>
    <a class="btn" href="/admin/exa">进入管理 →</a>
  </div>
  <div class="card stat">
    <h2>分发 Keys</h2>
    <div class="stat-num">${data.distTotal}</div>
    <div class="muted">启用 ${data.distEnabled} · 停用 ${data.distTotal - data.distEnabled}</div>
    <a class="btn" href="/admin/keys">进入管理 →</a>
  </div>
  <div class="card stat">
    <h2>今日调用</h2>
    <div class="stat-num">${data.todayCalls}</div>
    <div class="muted">统计日：${esc(data.today)}</div>
  </div>
</section>`;
  return layout("总览 · Tavily Proxy", body, { active: "dashboard" });
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
  flash?: string
): string {
  const flashHtml = flash ? `<div class="toast" style="margin-bottom:8px;">${esc(flash)}</div>` : "";
  const rows = keys.length
    ? keys
        .map((k) => {
          const st =
            k.status === "enabled"
              ? `<span class="badge ok">enabled</span>`
              : `<span class="badge off">disabled</span>`;
          const created = new Date(k.created_at).toLocaleString("zh-CN", {
            timeZone: "Asia/Shanghai",
          });
          const s = callsMap[k.api_key] ?? { tavily: 0, exa: 0 };
          const total = s.tavily + s.exa;
          return `<tr>
            <td>${esc(maskKey(k.api_key))}</td>
            <td>${esc(k.note)}</td>
            <td>${st}</td>
            <td class="muted">${esc(created)}</td>
            <td title="Tavily ${s.tavily} · Exa ${s.exa}">${total} <span class="muted" style="font-size:11px;">(T ${s.tavily}/E ${s.exa})</span></td>
            <td>
              <div style="display:flex;gap:4px;flex-wrap:wrap;align-items:center;">
                <button class="ghost" type="button" data-copy="tavily-${esc(k.api_key)}" title="复制调用凭据：Bearer tavily-&lt;key&gt;（请求走 Tavily）" style="padding:3px 8px;">复制 tavily 调用key</button>
                <button class="ghost" type="button" data-copy="exa-${esc(k.api_key)}" title="复制调用凭据：Bearer exa-&lt;key&gt;（请求走 Exa）" style="padding:3px 8px;">复制 exa 调用key</button>
                <form hx-post="/admin/keys/${esc(k.api_key)}/toggle" hx-target="#keys-list"
                      hx-swap="innerHTML" style="display:inline-block;">
                  ${csrfField(csrf)}
                  <button class="ghost" type="submit" style="padding:3px 8px;">${k.status === "enabled" ? "停用" : "启用"}</button>
                </form>
                <form hx-post="/admin/keys/${esc(k.api_key)}/delete" hx-target="#keys-list"
                      hx-swap="innerHTML" hx-confirm="确认删除该分发 key？" style="display:inline-block;">
                  ${csrfField(csrf)}
                  <button class="danger" type="submit" style="padding:3px 8px;">删除</button>
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
  <table>
    <thead><tr><th>Key</th><th>备注</th><th>状态</th><th>创建时间</th>
      <th>当日调用</th><th>操作</th></tr></thead>
    <tbody>${rows}</tbody>
  </table>`;
}

/** 生成成功：明文只显示这一次。返回的片段带明文框（含前缀用法提示）与刷新后的列表。 */
export function distGenerateResult(
  plainApiKey: string,
  keys: DistributedKey[],
  callsMap: Record<string, DistStats>,
  csrf: string
): string {
  const box = `<div class="plain">新 Key（请立即保存，只显示这一次）：<br>${esc(plainApiKey)}</div>
<div class="hint" style="margin-bottom:8px;">新 key 是<strong>调用本服务的凭据</strong>（非外部服务 key）：请求时用 <code>Bearer tavily-${esc(plainApiKey)}</code>（走 Tavily）或 <code>Bearer exa-${esc(plainApiKey)}</code>（走 Exa）。</div>`;
  return box + distListFragment(keys, callsMap, csrf);
}

/** 二次密码确认查看明文已随复制按钮移除（明文已注入行内，无需再查）。 */

export function errorFragment(msg: string): string {
  return `<div class="err">${esc(msg)}</div>`;
}
