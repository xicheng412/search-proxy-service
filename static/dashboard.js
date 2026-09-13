// Dashboard 图表渲染：读两个 DOM JSON（#dist-series / #upstream-series，由 src/views/index.ts
// 的 dashboardScript 注入 HTML）；依赖已先行加载的 Chart.js 全局 `Chart`；被 dashboardScript
// 输出的 `<script src="/dashboard.js"></script>` 引用（在 chart.js CDN 之后）。
// 24h/昨日/今日卡消费 dist 序列（calls = 跨 provider 请求合计）；近 5 天趋势图消费 upstream 序列
// （Tavily/Exa 两条真实调用尝试线）。下方 Chart.datasets 仅在 upstream 语义下按 provider 名
// 硬编码 tavily/exa（dist 序列无须参与）——新增 provider 时须扩展 UpstreamSeriesPoint、
// readUpstreamSeries 的折叠与本文件 dataset（见 docs/architecture.md §4.2 已知例外）。
(function () {
  // 图表配色从 admin.css 的 :root token 读取（canvas 不吃 CSS，需运行时取值再交给 Chart.js）：
  // --accent（Tavily 系列线）/ --muted（坐标刻度）/ --line（网格线）/ --txt（图例文字）；
  // 取不到时退回内置兜底值。Exa 系列色 #a78bfa 是数据专属编码色，不在主题 token 内，下方直用。
  var styles = getComputedStyle(document.documentElement);
  var readVar = function (name, fallback) {
    var v = styles.getPropertyValue(name).trim();
    return v || fallback;
  };
  var distEl = document.getElementById('dist-series');
  var upstreamEl = document.getElementById('upstream-series');
  if (!distEl || !upstreamEl) return;
  var dist;
  var upstream;
  try { dist = JSON.parse(distEl.textContent); } catch (e) { dist = null; }
  try { upstream = JSON.parse(upstreamEl.textContent); } catch (e) { upstream = null; }
  var setNum = function (id, n) {
    var el = document.getElementById(id);
    if (el) el.textContent = String(typeof n === 'number' && isFinite(n) ? n : 0);
  };
  var tv = function (p, k) {
    var v = p[k];
    return typeof v === 'number' && isFinite(v) ? v : 0;
  };
  var toUtc = function (hour) {
    var t = Date.parse(hour + 'Z'); // hour 为 UTC 小时桶，裸解析会被当成本地时间错 8 小时 → 补 'Z'。
    return isFinite(t) ? t : NaN;
  };

  // 最近 24 小时（含当前不完整小时）总计：dist 序列跨 provider 的 calls 合计。
  if (Array.isArray(dist)) {
    var cutoff = Date.now() - 24 * 3600 * 1000;
    var sum24 = 0;
    for (var i = 0; i < dist.length; i++) {
      var t = toUtc(dist[i].hour);
      if (t >= cutoff) sum24 += tv(dist[i], 'calls');
    }
    setNum('calls-24h', sum24);
  } else {
    setNum('calls-24h', 0);
  }

  // 本地日总计：按浏览器本地时区把 UTC 小时桶归到本地日期后对 dist 序列求和。
  // offsetDays: 0=今日（含当前不完整小时），-1=昨日。日历日分组对 DST 天然正确。
  var p2 = function (n) { return (n < 10 ? '0' : '') + n; };
  var localDayTotal = function (offsetDays) {
    var d0 = new Date();
    d0.setDate(d0.getDate() + offsetDays);
    var ymd = d0.getFullYear() + '-' + p2(d0.getMonth() + 1) + '-' + p2(d0.getDate());
    var sum = 0;
    if (Array.isArray(dist)) {
      for (var j = 0; j < dist.length; j++) {
        var t2 = toUtc(dist[j].hour);
        if (isNaN(t2)) continue;
        var d = new Date(t2);
        var k = d.getFullYear() + '-' + p2(d.getMonth() + 1) + '-' + p2(d.getDate());
        if (k === ymd) sum += tv(dist[j], 'calls');
      }
    }
    return sum;
  };
  setNum('calls-yesterday', localDayTotal(-1));
  setNum('calls-today', localDayTotal(0));

  var canvas = document.getElementById('calls-chart');
  if (!canvas || typeof Chart === 'undefined') return;
  if (!Array.isArray(upstream) || upstream.length === 0) return; // 图仅上游数据；空 → 不渲染
  var pts = upstream.map(function (p) {
    return { t: toUtc(p.hour), tavily: tv(p, 'tavily'), exa: tv(p, 'exa') };
  });
  new Chart(canvas, {
    type: 'line',
    data: {
      labels: pts.map(function (p) {
        return new Date(p.t).toLocaleString('zh-CN', {
          month: '2-digit', day: '2-digit', hour: '2-digit', hour12: false,
        });
      }),
      datasets: [
        { label: 'Tavily', data: pts.map(function (p) { return p.tavily; }),
          borderColor: readVar('--accent', '#38bdf8'),
          backgroundColor: readVar('--accent', '#38bdf8'), fill: false,
          spanGaps: true, pointRadius: 1.5 },
        { label: 'Exa', data: pts.map(function (p) { return p.exa; }),
          // Exa 数据系列专属色（非主题 token，数据编码而非主题）
          borderColor: '#a78bfa', backgroundColor: '#a78bfa', fill: false,
          spanGaps: true, pointRadius: 1.5 },
      ],
    },
    options: {
      responsive: true,
      maintainAspectRatio: false,
      interaction: { mode: 'index', intersect: false },
      scales: {
        x: { ticks: { color: readVar('--muted', '#94a3b8'), maxTicksLimit: 10, maxRotation: 0 },
             grid: { color: readVar('--line', '#334155') } },
        y: { beginAtZero: true, ticks: { color: readVar('--muted', '#94a3b8'), precision: 0 },
             grid: { color: readVar('--line', '#334155') } },
      },
      plugins: { legend: { labels: { color: readVar('--txt', '#e2e8f0') } } },
    },
  });
})();
