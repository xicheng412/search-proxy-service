// 公开使用说明页：独立于管理后台的静态页面（自带样式，不依赖 admin 的 layout/CSS/htmx）。
// 调用方 / 下游浏览 GET /help 即可看到前缀、端点、错误语义，无需登录。

import { esc } from "./index";

export function helpPage(publicBaseUrl: string = ""): string {
  const base = esc(publicBaseUrl);
  return `<!doctype html>
<html lang="zh-CN">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>使用说明 · Tavily Proxy</title>
<style>
  :root { --txt:#111827; --muted:#6b7280; --line:#e5e7eb; --accent:#0369a1; --code-bg:#f3f4f6; }
  * { box-sizing:border-box; }
  body { margin:0; font-family:system-ui,-apple-system,"Segoe UI",Roboto,sans-serif;
         color:var(--txt); line-height:1.6; }
  main { max-width:820px; margin:0 auto; padding:32px 20px 64px; }
  h1 { font-size:22px; margin:0 0 4px; }
  .lead { color:var(--muted); margin:0 0 24px; }
  h2 { font-size:16px; margin:28px 0 8px; padding-bottom:6px; border-bottom:1px solid var(--line); }
  p { margin:8px 0; }
  code { font-family:ui-monospace,Menlo,monospace; font-size:0.92em;
         background:var(--code-bg); padding:1px 5px; border-radius:4px; }
  pre { background:var(--code-bg); border:1px solid var(--line); border-radius:8px;
        padding:10px 12px; overflow-x:auto; font-family:ui-monospace,Menlo,monospace;
        font-size:12.5px; line-height:1.5; white-space:pre; }
  pre code { background:none; padding:0; }
  table { width:100%; border-collapse:collapse; font-size:13.5px; margin:8px 0; }
  th,td { text-align:left; padding:6px 8px; border-bottom:1px solid var(--line); vertical-align:top; }
  th { font-weight:600; }
  .errors th:first-child { width:56px; }
  .hint { color:var(--muted); font-size:13px; }
  .dep { margin:14px 0 4px; font-size:13.5px; }
  ul { margin:8px 0; padding-left:20px; }
  a { color:var(--accent); }
</style>
</head>
<body>
<main>
  <h1>使用说明</h1>
  <p class="lead">Tavily / Exa 搜索与提取 API 密钥代理 · 调用方请阅读本页。</p>

  <h2>概念</h2>
  <p>本服务把上游真实 key（Tavily / Exa 官方 key）收口在中间层，只向下游分发<strong>纯字符串的分发 key</strong>。
  调用时用 <code>Authorization: Bearer &lt;前缀&gt;-&lt;key&gt;</code> 请求代理端点。<strong>前缀选 provider、端点选能力、协议选包装</strong>：</p>
  <ul>
    <li><code>tavily-&lt;key&gt;</code>、<code>exa-&lt;key&gt;</code> —— native 原生透传（<code>tavily-</code> 可打 Search 与 Extract；<code>exa-</code> 只打 Search）</li>
    <li><code>searxng-tavily-&lt;key&gt;</code> —— SearXNG 兼容协议（GET/POST 调 Tavily Search，后端仅 Tavily）</li>
    <li><code>reader-tavily-&lt;key&gt;</code> —— reader 协议（GET <code>/reader/&lt;url&gt;</code> 拿页面正文，后端 Tavily Extract）</li>
  </ul>
  <p>同一个分发 key 不绑定 provider，前缀任选；<code>tavily-</code> 前缀可打 Search（<code>/search</code>）也可打 Extract（<code>/extract</code>）。</p>

  <h2>调用示例</h2>
  <p class="dep"><code>POST /search</code> —— Tavily Search（native 透传）</p>
<pre><code>curl -X POST ${base}/search \\
  -H "Authorization: Bearer tavily-&lt;分发key&gt;" \\
  -H "Content-Type: application/json" \\
  -d '{"query":"what is the latest news about AI","max_results":3}'</code></pre>

  <p class="dep"><code>POST /search</code> —— Exa Search（native 透传）</p>
<pre><code>curl -X POST ${base}/search \\
  -H "Authorization: Bearer exa-&lt;分发key&gt;" \\
  -H "Content-Type: application/json" \\
  -d '{"query":"what is the latest news about AI","numResults":3}'</code></pre>

  <p class="dep"><code>GET /search</code> —— Tavily Search（searxng 协议）</p>
<pre><code>curl -L -X GET "${base}/search?q=what+is+new+in+AI&amp;format=json" \\
  -H "Authorization: Bearer searxng-tavily-&lt;分发key&gt;"</code></pre>

  <p class="dep"><code>POST /extract</code> —— Tavily Extract（native 透传）</p>
<pre><code>curl -X POST ${base}/extract \\
  -H "Authorization: Bearer tavily-&lt;分发key&gt;" \\
  -H "Content-Type: application/json" \\
  -d '{"urls":["https://en.wikipedia.org/wiki/Artificial_intelligence"],"extract_depth":"basic"}'</code></pre>

  <p class="dep"><code>GET /reader/&lt;url&gt;</code> —— 页面正文（reader 协议）</p>
<pre><code>curl "${base}/reader/https://en.wikipedia.org/wiki/Artificial_intelligence" \\
  -H "Authorization: Bearer reader-tavily-&lt;分发key&gt;"
# → 200 text/plain：目标页面正文文本；?depth=basic|advanced 可透传提取深度（缺省 basic）</code></pre>

  <p class="hint">searxng 返回 SearXNG 标准 JSON（query/results/answers/infoboxes 等）；reader 返回纯文本。
  reader 目标 URL 若自身带 query，需整体 percent-encode（否则 <code>?</code> 后会被当作外层请求参数）。
  同一个分发 key 可以同时用 <code>tavily-</code> / <code>exa-</code> / <code>searxng-tavily-</code> / <code>reader-tavily-</code> 前缀。</p>

  <h2>状态与错误</h2>
  <table class="errors">
    <thead><tr><th>状态</th><th>含义</th></tr></thead>
    <tbody>
      <tr><td>2xx</td><td><code>native</code>：上游原始响应原样透传（结构由上游决定）；<code>searxng</code>：SearXNG 标准 JSON；<code>reader</code>：目标页正文纯文本</td></tr>
      <tr><td>429</td><td>自动换另一个可用上游 key 重试一次；仍 429 返回上游错误</td></tr>
      <tr><td>432</td><td>（Tavily）key / plan 限额耗尽：换 key 重试一次；仍 432 透传上游错误</td></tr>
      <tr><td>433</td><td>（Tavily）PayGo 余额耗尽：立即透传上游错误，不重试</td></tr>
      <tr><td>401</td><td>分发 key 缺失 / 无效 / 禁用，或前缀非法</td></tr>
      <tr><td>400</td><td>（searxng）缺 <code>q</code> 或 <code>format</code> 非 json；<code>native</code> 透传上游 400；（reader）缺目标 URL</td></tr>
      <tr><td>405</td><td>（/reader、/extract）协议与该端点不匹配——如用 native/searxng 打 /reader</td></tr>
      <tr><td>502</td><td>（reader）目标页抓取失败（Tavily failed_results）或上游不可达</td></tr>
      <tr><td>503</td><td>该 provider 无可用的上游 key（全部禁用或冷却中）</td></tr>
    </tbody>
  </table>

  <h2>概念区分</h2>
  <p><strong>上游官方 key</strong>（后台 Tavily Keys / Exa Keys 页）：外部服务真实 key，仅本服务持有、转发用，列表始终脱敏。</p>
  <p><strong>分发 key</strong>（后台分发 Keys 页生成）：调用凭据纯字符串，请求时写成 <code>tavily-&lt;key&gt;</code>、<code>exa-&lt;key&gt;</code>、<code>searxng-tavily-&lt;key&gt;</code> 或 <code>reader-tavily-&lt;key&gt;</code>。</p>
  <p class="hint">统计口径：后台「当日成功/失败」与趋势图统计上游官方 key 的真实调用尝试；Dashboard 24h/昨日/今日卡与分发 Keys 页统计分发 key 的请求次数。两条线维度不同、勿互相核对，且均为近似值。</p>

  <h2>后台功能与文档</h2>
  <ul>
    <li><strong>Tavily Keys / Exa Keys</strong>：管理上游官方 key（test call、改名、启停、删除），含当日成功/失败、冷却状态。</li>
    <li><strong>分发 Keys</strong>：生成 / 启停 / 删除分发 key，操作列「复制」一键复制组装好的调用凭据。</li>
    <li><strong>冷却</strong>：每次使用后短冷却；非 429 失败指数退避、成功归零；401/403 疑似失效长冷却。</li>
    <li><strong>管理</strong>：<code>/admin</code> 需管理员登录；新增/删除与全局参数（冷却、队列、鉴权缓存）都在那里。</li>
    <li><strong>文档</strong>：<code>README.md</code>（概览与部署）、<code>docs/architecture.md</code>（架构与设计）。</li>
  </ul>
</main>
</body>
</html>`;
}
