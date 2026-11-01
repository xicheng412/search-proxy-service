// ---------------------------------------------------------------
// Dashboard 总览页
// ---------------------------------------------------------------

import { csrfField } from "./html";
import { layout } from "./index";
import { card, field, icon, pageHeader, statCard } from "./ui";
import type { DistSummaries } from "../usage";

export interface DashboardData {
  tavilyTotal: number;
  tavilyEnabled: number;
  exaTotal: number;
  exaEnabled: number;
  distTotal: number;
  distEnabled: number;
  distSeries: string;
  upstreamSeries: string;
  distSummaries: DistSummaries;
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
${pageHeader({
  title: "总览",
  description: "上游健康与分发用量 · 最近 5 天",
  actions: `<a class="btn btn-secondary btn-sm" href="/admin">${icon("refresh")}重新整理</a>`,
})}
<section class="stats-grid">
  ${statCard({
    label: "Tavily Keys",
    value: data.tavilyTotal,
    meta: `启用 ${data.tavilyEnabled} · 停用 ${data.tavilyTotal - data.tavilyEnabled}`,
    href: "/admin/tavily",
    tone: data.tavilyTotal === 0 ? "bad" : data.tavilyEnabled === data.tavilyTotal ? "ok" : "warn",
  })}
  ${statCard({
    label: "Exa Keys",
    value: data.exaTotal,
    meta: `启用 ${data.exaEnabled} · 停用 ${data.exaTotal - data.exaEnabled}`,
    href: "/admin/exa",
    tone: data.exaTotal === 0 ? "bad" : data.exaEnabled === data.exaTotal ? "ok" : "warn",
  })}
  ${statCard({
    label: "分发 Keys",
    value: data.distTotal,
    meta: `启用 ${data.distEnabled} · 停用 ${data.distTotal - data.distEnabled}`,
    href: "/admin/keys",
    tone: data.distTotal === 0 ? "bad" : data.distEnabled === data.distTotal ? "ok" : "warn",
  })}
</section>
<div class="dashboard-grid">
  ${card({
    className: "chart-card",
    title: "近 5 天调用趋势",
    description: "上游真实调用 · 按小时聚合",
    actions: `<div class="chart-legend" aria-hidden="true">
      <span class="legend-item"><span class="legend-swatch legend-swatch-tavily"></span>Tavily</span>
      <span class="legend-item"><span class="legend-swatch legend-swatch-exa"></span>Exa</span>
    </div>`,
    body: `<div class="chart-box"><canvas id="calls-chart" role="img" aria-label="近 5 天 Tavily 与 Exa 调用趋势"></canvas></div>`,
  })}
  ${card({
    className: "signals-card",
    title: "分发请求量",
    description: "UTC 日 · 含当前桶",
    body: `<div class="signal-list">
      <div class="signal-row"><span class="signal-label">最近 24h</span><div class="stat-num" id="calls-24h">${data.distSummaries.last24h}</div></div>
      <div class="signal-row"><span class="signal-label">昨日</span><div class="stat-num" id="calls-yesterday">${data.distSummaries.yesterday}</div></div>
      <div class="signal-row"><span class="signal-label">今日</span><div class="stat-num" id="calls-today">${data.distSummaries.today}</div></div>
    </div>`,
  })}
</div>
${card({
  title: "运行参数",
  description: "修改后 ≤3s 生效，无需重新部署。",
  body: `<div class="settings-grid">
    <form method="post" action="/admin/queue-config" class="settings-group">
      ${csrfField(data.csrf)}
      <div>
        <h3 class="settings-title">上游请求队列</h3>
        <p class="settings-desc">突发请求串行放行；超过 maxDepth 或 waitBudgetMs 返回 429。</p>
      </div>
      <div class="form-grid">
        ${field({ label: "间隔", name: "intervalMs", type: "number", value: data.queueIntervalMs, min: 100, unit: "ms", required: true })}
        ${field({ label: "最大等待数", name: "maxDepth", type: "number", value: data.queueMaxDepth, min: 1, required: true })}
        ${field({ label: "等待上限", name: "waitBudgetMs", type: "number", value: data.queueWaitBudgetMs, min: 1000, unit: "ms", required: true })}
      </div>
      <div class="settings-actions"><button class="btn btn-primary btn-sm" type="submit">保存</button></div>
    </form>
    <form method="post" action="/admin/breaker-config" class="settings-group">
      ${csrfField(data.csrf)}
      <div>
        <h3 class="settings-title">冷却与熔断</h3>
        <p class="settings-desc">每次使用后固定冷却；非 429 失败指数退避；疑似失效长冷却。</p>
      </div>
      <div class="form-grid">
        ${field({ label: "每次使用冷却", name: "postUseCooldownSec", type: "number", value: data.postUseCooldownSec, min: 0, step: 1, unit: "秒", required: true })}
        ${field({ label: "熔断基数", name: "breakerBaseSec", type: "number", value: data.breakerBaseSec, min: 1, step: 1, unit: "秒", required: true })}
        ${field({ label: "疑似失效", name: "invalidCooldownSec", type: "number", value: data.invalidCooldownSec, min: 1, step: 1, unit: "秒", required: true })}
      </div>
      <div class="settings-actions"><button class="btn btn-primary btn-sm" type="submit">保存</button></div>
    </form>
    <form method="post" action="/admin/dist-cache-config" class="settings-group">
      ${csrfField(data.csrf)}
      <div>
        <h3 class="settings-title">鉴权缓存</h3>
        <p class="settings-desc">命中缓存时不读 D1；写路径会主动失效。</p>
      </div>
      <div class="form-grid">
        ${field({ label: "缓存 TTL", name: "cacheTtlSec", type: "number", value: data.distCacheTtlSec, min: 1, step: 1, unit: "秒", required: true })}
      </div>
      <div class="settings-actions"><button class="btn btn-primary btn-sm" type="submit">保存</button></div>
    </form>
  </div>`,
})}`;
  return layout("总览 · Tavily Proxy", body, {
    active: "dashboard",
    scripts: dashboardScript(data.distSeries, data.upstreamSeries),
  });
}

/**
 * Dashboard 图表脚本：注入 dist / upstream 两段序列 JSON（`\u003c` 转义防 `</script`），
 * 再按序引入 Chart.js CDN、date-fns time-scale 适配器与 static/dashboard.js——统计卡与
 * 趋势图的渲染逻辑已移入该文件，其 dataset 语义见 static/dashboard.js 顶部注释。
 * Chart.js 时间轴需额外引入 date-fns 适配器（chartjs-adapter-date-fns 3.0.0，自带 date-fns，
 * `Chart` 全局存在时自动注册 _adapters._date，无需额外 JS）。
 * JSON 注入用 `\u003c` 而非 HTML esc：`<script>` 内容是 raw text，实体不反解码，
 * esc 把 `"` 变 `&quot;` 会破坏 JSON；`\u003c` 是合法 JSON 转义且防 `</script`/`<!--`。
 */
function dashboardScript(
  distSeriesJson: string,
  upstreamSeriesJson: string
): string {
  return `<script type="application/json" id="dist-series">${distSeriesJson.replace(/</g, "\\u003c")}</script>
<script type="application/json" id="upstream-series">${upstreamSeriesJson.replace(/</g, "\\u003c")}</script>
<script src="https://cdn.jsdelivr.net/npm/chart.js@4.4.1/dist/chart.umd.min.js"></script>
<script src="https://cdn.jsdelivr.net/npm/chartjs-adapter-date-fns@3.0.0/dist/chartjs-adapter-date-fns.bundle.min.js"></script>
<script src="/dashboard.js"></script>`;
}
