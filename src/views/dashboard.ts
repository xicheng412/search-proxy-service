// ---------------------------------------------------------------
// Dashboard 总览页
// ---------------------------------------------------------------

import { csrfField, layout } from "./index";

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