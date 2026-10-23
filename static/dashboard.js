// Dashboard 图表渲染：读两个 DOM JSON（#dist-series / #upstream-series，由 src/views/index.ts
// 的 dashboardScript 注入 HTML）；依赖已先行加载的 Chart.js 全局 `Chart`；被 dashboardScript
// 输出的 `<script src="/dashboard.js"></script>` 引用（在 chart.js CDN 之后）。
// 近 5 天趋势图消费 upstream 序列（Tavily/Exa 两条真实调用尝试线）。24h/昨日/今日三张卡由
// 服务端 readDistSummaries 计算后直接渲染进 HTML，前端只负责显示、不再按时区归日。
// 趋势图：服务端按 15min 桶返回（存储/精度需要），但 5 天 ~480 点画折线视觉上过密且忽高忽低，
// 故本文件先按整点小时聚合（同一 UTC 小时内 4 个桶求和）再交给 Chart.js，刻度也回到小时。
// 下方 Chart.datasets 仅在 upstream 语义下按 provider 名硬编码 tavily/exa（dist 序列无须参与）
// ——新增 provider 时须扩展 UpstreamSeriesPoint、readUpstreamSeries 的折叠与本文件 dataset
// （见 docs/architecture.md §4.2 已知例外）。
(function () {
  // 图表配色从 admin.css 的 :root token 读取（canvas 不吃 CSS，需运行时取值再交给 Chart.js）：
  // --accent（Tavily 系列线）/ --muted（坐标刻度）/ --line（网格线）/ --txt（图例文字）；
  // 取不到时退回内置兜底值。Exa 系列色 #a78bfa 是数据专属编码色，不在主题 token 内，下方直用。
  var styles = getComputedStyle(document.documentElement);
  var readVar = function (name, fallback) {
    var v = styles.getPropertyValue(name).trim();
    return v || fallback;
  };
  var upstreamEl = document.getElementById('upstream-series');
  if (!upstreamEl) return;
  var upstream;
  try { upstream = JSON.parse(upstreamEl.textContent); } catch (e) { upstream = null; }
  var tv = function (p, k) {
    var v = p[k];
    return typeof v === 'number' && isFinite(v) ? v : 0;
  };

  /**
   * 15min 桶 → 整点小时聚合：key = 'YYYY-MM-DDTHH'（bucket.slice(0,13)）。
   * 依赖服务端桶键定长 16 字符且字典序=时间序，故截断后仍按时间有序；
   * 同小时内 4 个桶的 tavily/exa 各自求和。返回按小时升序的 [{ t, tavily, exa }]。
   */
  var toHourly = function (rows) {
    var byHour = {};
    var order = [];
    for (var i = 0; i < rows.length; i++) {
      var b = rows[i].bucket;
      if (typeof b !== 'string' || b.length < 13) continue;
      var h = b.slice(0, 13);
      var acc = byHour[h];
      if (!acc) {
        acc = byHour[h] = { hour: h, tavily: 0, exa: 0 };
        order.push(acc);
      }
      acc.tavily += tv(rows[i], 'tavily');
      acc.exa += tv(rows[i], 'exa');
    }
    var out = [];
    for (var j = 0; j < order.length; j++) {
      var t = Date.parse(order[j].hour + ':00Z'); // 补 ':00Z'：整点 UTC，裸解析会被当本地时间错位。
      out.push({ t: isFinite(t) ? t : NaN, tavily: order[j].tavily, exa: order[j].exa });
    }
    return out;
  };

  var canvas = document.getElementById('calls-chart');
  if (!canvas || typeof Chart === 'undefined') return;
  if (!Array.isArray(upstream) || upstream.length === 0) return; // 图仅上游数据；空 → 不渲染
  if (typeof upstream[0] === 'object' && upstream[0] && 'hour' in upstream[0]) {
    return; // 防御：已是小时粒度则无需聚合（当前服务端为 15min 桶）
  }
  var pts = toHourly(upstream);
  if (pts.length === 0) return;
  new Chart(canvas, {
    type: 'line',
    data: {
      // x 用真实时间（Chart.js time scale，需 chartjs-adapter-date-fns）：按小时聚合后每点代表一个
      // 整点小时的总量，坐标按真实时间等间隔、不跳格，无需 spanGaps。
      datasets: [
        { label: 'Tavily', data: pts.map(function (p) { return { x: p.t, y: p.tavily }; }),
          borderColor: readVar('--accent', '#38bdf8'),
          backgroundColor: readVar('--accent', '#38bdf8'), fill: false,
          pointRadius: 1.5 },
        { label: 'Exa', data: pts.map(function (p) { return { x: p.t, y: p.exa }; }),
          // Exa 数据系列专属色（非主题 token，数据编码而非主题）
          borderColor: '#a78bfa', backgroundColor: '#a78bfa', fill: false,
          pointRadius: 1.5 },
      ],
    },
    options: {
      responsive: true,
      maintainAspectRatio: false,
      interaction: { mode: 'index', intersect: false },
      scales: {
        x: { type: 'time',
             time: { unit: 'hour', tooltipFormat: 'MM/dd HH:mm', displayFormats: { hour: 'MM/dd HH:mm' } },
             ticks: { color: readVar('--muted', '#94a3b8'), maxTicksLimit: 10, maxRotation: 0 },
             grid: { color: readVar('--line', '#334155') } },
        y: { beginAtZero: true, ticks: { color: readVar('--muted', '#94a3b8'), precision: 0 },
             grid: { color: readVar('--line', '#334155') } },
      },
      plugins: { legend: { labels: { color: readVar('--txt', '#e2e8f0') } } },
    },
  });
})();
