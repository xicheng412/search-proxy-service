// 管理后台的 HTML 构建（原生 HTML + HTMX）。所有页面/片段均由此生成。

import {
  DistributedKey,
  TavilyKey,
  TavilyStats,
  maskKey,
  todayDate,
} from "./kv";

function esc(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

type NavKey = "dashboard" | "tavily" | "keys";

const NAV_ITEMS: { key: NavKey; href: string; label: string }[] = [
  { key: "dashboard", href: "/admin", label: "总览" },
  { key: "tavily", href: "/admin/tavily", label: "Tavily Keys" },
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
    .logout{ color:var(--muted); }
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

function csrfField(token: string): string {
  return `<input type="hidden" name="csrf_token" value="${esc(token)}">`;
}

// ---------------------------------------------------------------
// 管理后台主页（两个区块）
// ---------------------------------------------------------------

// ---------------------------------------------------------------
// Dashboard 总览页
// ---------------------------------------------------------------

export interface DashboardData {
  tavilyTotal: number;
  tavilyEnabled: number;
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
// Tavily Keys 独立管理页
// ---------------------------------------------------------------

export function tavilyPage(csrf: string, fragment: string): string {
  const body = `
<section class="card">
  <h2>Tavily Keys · 管理</h2>
  <div id="tavily-list">${fragment}</div>
</section>
<input type="hidden" id="csrf" value="${esc(csrf)}">`;
  return layout("Tavily Keys · Tavily Proxy", body, { active: "tavily" });
}

// ---------------------------------------------------------------
// 分发 Keys 独立管理页
// ---------------------------------------------------------------

export function keysPage(csrf: string, fragment: string): string {
  const body = `
<section class="card">
  <h2>分发 Keys · 管理</h2>
  <div id="keys-list">${fragment}</div>
</section>
<input type="hidden" id="csrf" value="${esc(csrf)}">`;
  return layout("分发 Keys · Tavily Proxy", body, { active: "keys" });
}

// ---------------------------------------------------------------
// Tavily Keys 区块
// ---------------------------------------------------------------

export function tavilyListFragment(
  keys: TavilyKey[],
  statsMap: Record<string, TavilyStats>,
  csrf: string,
  now: number,
  flash?: string
): string {
  const flashHtml = flash ? `<div class="toast" style="margin-bottom:8px;">${esc(flash)}</div>` : "";
  const rows = keys.length
    ? keys
        .map((k) => {
          const s = statsMap[k.id] ?? { success: 0, fail: 0 };
          const cooling =
            k.cooldown_until != null && k.cooldown_until > now
              ? `<span class="badge warn">冷却中</span>`
              : `<span class="muted">-</span>`;
          const st =
            k.status === "enabled"
              ? `<span class="badge ok">enabled</span>`
              : `<span class="badge off">disabled</span>`;
          return `<tr>
            <td>${esc(maskKey(k.key))}</td>
            <td>${esc(k.name)}</td>
            <td>${st}</td>
            <td>${cooling}</td>
            <td>${s.success}</td>
            <td>${s.fail}</td>
            <td>
              <form hx-post="/admin/tavily/${esc(k.id)}/toggle" hx-target="#tavily-list"
                    hx-swap="innerHTML" style="display:inline;">
                ${csrfField(csrf)}
                <button class="ghost" type="submit">${k.status === "enabled" ? "停用" : "启用"}</button>
              </form>
              <form hx-post="/admin/tavily/${esc(k.id)}/delete" hx-target="#tavily-list"
                    hx-swap="innerHTML" hx-confirm="确认删除该 Tavily key？" style="display:inline;">
                ${csrfField(csrf)}
                <button class="danger" type="submit">删除</button>
              </form>
            </td>
          </tr>`;
        })
        .join("")
    : `<tr><td colspan="7" class="muted">暂无 Tavily key，请先添加。</td></tr>`;

  return `${flashHtml}
  <form class="row" hx-post="/admin/tavily/add" hx-target="#tavily-list" hx-swap="innerHTML">
    ${csrfField(csrf)}
    <input type="text" name="name" placeholder="备注（如：主 key）" required>
    <input type="text" name="key" placeholder="tvly-xxx" required>
    <label class="muted" style="align-self:center;font-size:12px;white-space:nowrap;">
      <input type="checkbox" name="test" value="1" style="vertical-align:middle;"> 加入时验证
    </label>
    <button type="submit">添加</button>
  </form>
  <table>
    <thead><tr><th>Key</th><th>备注</th><th>状态</th><th>冷却</th>
      <th>当日成功</th><th>当日失败</th><th>操作</th></tr></thead>
    <tbody>${rows}</tbody>
  </table>`;
}

export function tavilyAddResult(
  ctx: { error?: string; mask?: string }
): string {
  if (ctx.error) {
    return `<div class="err" style="margin-bottom:8px;">${esc(ctx.error)}</div>`;
  }
  return `<div class="toast" style="margin-bottom:8px;">已添加 ${esc(ctx.mask ?? "")} 并验证通过</div>`;
}

// ---------------------------------------------------------------
// 分发 Keys 区块
// ---------------------------------------------------------------

export function distListFragment(
  keys: DistributedKey[],
  callsMap: Record<string, number>,
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
          const calls = callsMap[k.api_key] ?? 0;
          return `<tr>
            <td>${esc(maskKey(k.api_key))}</td>
            <td>${esc(k.note)}</td>
            <td>${st}</td>
            <td class="muted">${esc(created)}</td>
            <td>${calls}</td>
            <td>
              <form hx-post="/admin/keys/${esc(k.api_key)}/view" hx-target="#plain-${esc(k.api_key)}"
                    hx-swap="innerHTML" style="display:inline;">
                ${csrfField(csrf)}
                <button class="ghost" type="submit">查看明文</button>
              </form>
              <form hx-post="/admin/keys/${esc(k.api_key)}/toggle" hx-target="#keys-list"
                    hx-swap="innerHTML" style="display:inline;">
                ${csrfField(csrf)}
                <button class="ghost" type="submit">${k.status === "enabled" ? "停用" : "启用"}</button>
              </form>
              <form hx-post="/admin/keys/${esc(k.api_key)}/delete" hx-target="#keys-list"
                    hx-swap="innerHTML" hx-confirm="确认删除该分发 key？" style="display:inline;">
                ${csrfField(csrf)}
                <button class="danger" type="submit">删除</button>
              </form>
            </td>
          </tr>
          <tr><td id="plain-${esc(k.api_key)}" colspan="6"></td></tr>`;
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

/** 生成成功：明文只显示这一次。返回的片段同时带明文框与刷新后的列表。 */
export function distGenerateResult(
  plainApiKey: string,
  keys: DistributedKey[],
  callsMap: Record<string, number>,
  csrf: string
): string {
  const box = `<div class="plain">新 Key（请立即保存，只显示这一次）：<br>${esc(plainApiKey)}</div>`;
  return box + distListFragment(keys, callsMap, csrf);
}

/** 二次密码确认查看明文。返回表单或明文。 */
export function distViewForm(csrf: string, apiKey: string): string {
  return `<form hx-post="/admin/keys/${esc(apiKey)}/view" hx-target="#plain-${esc(apiKey)}"
           hx-swap="innerHTML" style="margin-bottom:8px;">
    ${csrfField(csrf)}
    <label class="muted" style="font-size:12px;">为安全起见，请输入管理员密码确认：</label>
    <div style="display:flex;gap:8px;margin-top:6px;">
      <input type="password" name="password" style="flex:1;">
      <button type="submit">确认</button>
    </div>
  </form>`;
}

export function distViewPlain(apiKey: string): string {
  return `<div class="plain">${esc(apiKey)}</div>`;
}

export function errorFragment(msg: string): string {
  return `<div class="err">${esc(msg)}</div>`;
}

export function htmxToday(): string {
  return todayDate();
}
