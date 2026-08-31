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

type NavKey = "dashboard" | "tavily" | "exa" | "keys" | "help";

const NAV_ITEMS: { key: NavKey; href: string; label: string }[] = [
  { key: "dashboard", href: "/admin", label: "总览" },
  { key: "tavily", href: "/admin/tavily", label: "Tavily Keys" },
  { key: "exa", href: "/admin/exa", label: "Exa Keys" },
  { key: "keys", href: "/admin/keys", label: "分发 Keys" },
  { key: "help", href: "/admin/help", label: "使用说明" },
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
    .wrap > .card + .card { margin-top:20px; }
    pre.code{ background:#0f172a; border:1px solid var(--line); border-radius:8px;
      padding:10px 12px; font-family:ui-monospace,Menlo,monospace; font-size:12px;
      overflow-x:auto; white-space:pre; }
    .hl{ color:var(--accent); }
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
  queueIntervalMs: number;
  queueMaxDepth: number;
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
</section>
<section class="card">
  <h2>上游请求队列 · 参数</h2>
  <p class="hint" style="margin:0 0 12px;">突发请求会被串行放行到上游（Tavily / Exa 各自独立队列）：每个任务处理完隔 <strong>intervalMs</strong> 再放下一个；等待中达到 <strong>maxDepth</strong> 时新请求返回 429。改这里即生效（≤3s 内），无需重新部署。想在放开频率时调大数值即可。</p>
  <form method="post" action="/admin/queue-config" class="row">
    ${csrfField(data.csrf)}
    <label class="muted">间隔 (ms)</label>
    <input type="number" name="intervalMs" min="100" value="${data.queueIntervalMs}" required style="max-width:140px;">
    <label class="muted">最大等待数</label>
    <input type="number" name="maxDepth" min="1" value="${data.queueMaxDepth}" required style="max-width:140px;">
    <button type="submit">保存</button>
  </form>
</section>
<section class="card">
  <h2>冷却参数</h2>
  <p class="hint" style="margin:0 0 12px;"><strong>post-use</strong> 每次使用后（无论成败）的固定冷却；<strong>熔断</strong> 每次非 429 失败后指数退避 <code>base × 2^连续失败次数</code>；<strong>疑似失效</strong> 每次 401/403（key 级鉴权错误）后固定冷却，到点重试一次，成功自动恢复。三者在同一把 key 上取较久者生效。改这里即生效（≤3s 内），无需重新部署。</p>
  <form method="post" action="/admin/breaker-config" class="row">
    ${csrfField(data.csrf)}
    <label class="muted">每次使用冷却 (秒)</label>
    <input type="number" name="postUseCooldownSec" min="0" step="1" value="${data.postUseCooldownSec}" required style="max-width:140px;">
    <label class="muted">熔断基数 (秒)</label>
    <input type="number" name="breakerBaseSec" min="1" step="1" value="${data.breakerBaseSec}" required style="max-width:140px;">
    <label class="muted">疑似失效 (秒)</label>
    <input type="number" name="invalidCooldownSec" min="1" step="60" value="${data.invalidCooldownSec}" required style="max-width:140px;">
    <button type="submit">保存</button>
  </form>
</section>
<section class="card">
  <h2>鉴权缓存参数</h2>
  <p class="hint" style="margin:0 0 12px;">分发 key 鉴权结果缓存在 Cache API 中，命中时无需读取 D1。缓存 TTL 越长，D1 读越少；禁用/删除后的最坏生效延迟也越长。写路径会主动失效缓存。改这里即生效（≤3s 内），无需重新部署。</p>
  <form method="post" action="/admin/dist-cache-config" class="row">
    ${csrfField(data.csrf)}
    <label class="muted">鉴权缓存 TTL (秒)</label>
    <input type="number" name="cacheTtlSec" min="1" step="1" value="${data.distCacheTtlSec}" required style="max-width:140px;">
    <button type="submit">保存</button>
  </form>
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
                <button class="ghost" type="button" data-copy="searxng-tavily-${esc(k.api_key)}" title="复制调用凭据：Bearer searxng-tavily-&lt;key&gt;（SearXNG 协议，请求走 Tavily）" style="padding:3px 8px;">复制 searxng-tavily 调用key</button>
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
  <div style="display:flex;justify-content:flex-end;align-items:center;gap:6px;margin:-4px 0 10px;">
    ${publicBaseUrl ? `<span class="muted" style="font-size:11px;">${esc(publicBaseUrl)}</span>` : ""}
    <button class="ghost" type="button" data-copy="${esc(publicBaseUrl)}" title="复制调用基础地址" style="padding:3px 8px;">复制 base url</button>
    <button class="ghost" type="button" data-copy="${esc(publicBaseUrl + "/search")}" title="复制搜索端点：POST base/search" style="padding:3px 8px;">复制 /search</button>
  </div>
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
  csrf: string,
  publicBaseUrl: string = ""
): string {
  const box = `<div class="plain">新 Key（请立即保存，只显示这一次）：<br>${esc(plainApiKey)}</div>
<div class="hint" style="margin-bottom:8px;">新 key 是<strong>调用本服务的凭据</strong>（非外部服务 key）：请求时用 <code>Bearer tavily-${esc(plainApiKey)}</code>（走 Tavily）、<code>Bearer exa-${esc(plainApiKey)}</code>（走 Exa），或 <code>Bearer searxng-tavily-${esc(plainApiKey)}</code>（SearXNG 协议，走 Tavily）。</div>`;
  return box + distListFragment(keys, callsMap, csrf, undefined, publicBaseUrl);
}

/** 二次密码确认查看明文已随复制按钮移除（明文已注入行内，无需再查）。 */

export function errorFragment(msg: string): string {
  return `<div class="err">${esc(msg)}</div>`;
}

// ---------------------------------------------------------------
// 使用说明页（原理 + 调用方式 + 文档，管理员参考/转发给下游）
// ---------------------------------------------------------------

export function helpPage(publicBaseUrl: string = ""): string {
  const base = esc(publicBaseUrl);
  const body = `
<div class="card">
  <h2>使用说明</h2>
  <p class="muted">本服务把上游真实 Key（Tavily / Exa 官方 key）收口在中间层，只向下游分发<strong>纯字符串的分发 key</strong>。<br>
  调用方用 <code>Authorization: Bearer &lt;前缀&gt;-&lt;key&gt;</code> 请求代理端点。前缀同时决定<strong>协议</strong>与<strong>路由</strong>：<code>tavily-</code> / <code>exa-</code> 为原生透传（POST，原样转发上游协议）；<code>searxng-tavily-</code> 为 SearXNG 兼容协议（GET/POST，入参返回值按 SearXNG 标准，后端走 Tavily）。</p>
  <p class="muted"><strong>概念区分：</strong>「Tavily Keys / Exa Keys」页里的 key 是<strong>外部服务官方 key</strong>（仅本服务持有、转发用）；「分发 Keys」页生成的纯字符串是<strong>调用凭据</strong>，请求时写成 <code>tavily-&lt;key&gt;</code>、<code>exa-&lt;key&gt;</code> 或 <code>searxng-tavily-&lt;key&gt;</code>。</p>
</div>

<div class="card">
  <h2>调用示例（三种方式）</h2>
  <p class="muted">原生透传端点：<code>POST ${base}/search</code>（请求体请用对应上游官方的格式）；SearXNG 兼容端点：<code>GET|POST ${base}/search</code>。</p>

  <h3 style="font-size:14px;color:var(--accent);margin:12px 0 6px;">方式一：走 Tavily</h3>
<pre class="code">curl -X POST ${base}/search \\
  -H "Authorization: Bearer tavily-&lt;分发key&gt;" \\
  -H "Content-Type: application/json" \\
  -d '{"query":"what is the latest news about AI","max_results":3}'</pre>

  <h3 style="font-size:14px;color:var(--accent);margin:12px 0 6px;">方式二：走 Exa</h3>
<pre class="code">curl -X POST ${base}/search \\
  -H "Authorization: Bearer exa-&lt;分发key&gt;" \\
  -H "Content-Type: application/json" \\
  -d '{"query":"what is the latest news about AI","numResults":3}'
</pre>

  <h3 style="font-size:14px;color:var(--accent);margin:12px 0 6px;">方式三：走 SearXNG 兼容接口（GET）</h3>
<pre class="code">curl -L -X GET "${base}/search?q=what+is+new+in+AI&format=json" \\
  -H "Authorization: Bearer searxng-tavily-&lt;分发key&gt;"</pre>
  <p class="hint">同一个分发 key 可以同时用 <code>tavily-</code>、<code>exa-</code>、<code>searxng-tavily-</code> 前缀。列表里的「复制 tavily/exa/searxng-tavily 调用key」可直接复制完整凭据；「复制 base url / 复制 /search」复制本服务对外地址。SearXNG 返回为 searxng 标准 JSON（query/results/answers/infoboxes 等字段）。</p>
</div>

<div class="card">
  <h2>响应与错误</h2>
  <table>
    <thead><tr><th>状态</th><th>含义</th></tr></thead>
    <tbody>
      <tr><td>2xx</td><td><code>native</code>：上游原始响应原样透传（结构由上游决定）；<code>searxng</code>：转成 SearXNG 标准 JSON</td></tr>
      <tr><td>429</td><td>自动换另一个可用上游 key 重试一次；仍 429 返回上游错误</td></tr>
      <tr><td>401</td><td>分发 key 缺失 / 无效 / 禁用，或前缀非法（需 <code>tavily-</code>、<code>exa-</code> 或 <code>searxng-tavily-</code>）</td></tr>
      <tr><td>400</td><td>（searxng）缺 <code>q</code> 或 <code>format</code> 非 json；<code>native</code> 路径透传上游 400</td></tr>
      <tr><td>503</td><td>该 provider 无可用的上游 key（全部禁用或冷却中）</td></tr>
    </tbody>
  </table>
</div>

<div class="card">
  <h2>后台功能与文档</h2>
  <ul class="muted">
    <li><strong>Tavily Keys / Exa Keys</strong>：管理上游官方 key（可 test call、改备注、启停、删除），列表含当日成功/失败、冷却状态。</li>
    <li><strong>分发 Keys</strong>：生成 / 启停 / 删除分发 key，一键复制调用凭据；当日调用按 provider 拆分（T/E）。</li>
    <li><strong>冷却</strong>：每次使用后自动冷却 5 秒；非429失败触发指数退避冷却（60s × 2^连续失败次数），成功则连续失败归零。</li>
    <li><strong>统计</strong>：每日统计按 Asia/Shanghai 时区结算，KV 近似值、允许少量误差。</li>
    <li><strong>文档</strong>：<code>README.md</code>、<code>docs/plan.md</code>（原始需求）、<code>docs/exa-key-support.md</code>（当前实现与术语）。</li>
  </ul>
</div>`;
  return layout("使用说明 · Tavily Proxy", body, { active: "help" });
}
