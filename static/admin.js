// 后台公共脚本：被 src/views/index.ts 的 layout() 以 `<script src="/admin.js" defer>` 引用。
// 覆盖登录/管理页全部后台页面，负责一键复制、操作列下拉菜单、本地时区渲染三类行为。

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

// 操作列「复制」下拉菜单：点按钮开/关，点外部任意处（含菜单项）关闭。
// 菜单项带 data-copy，由上面的复制监听处理；本监听只负责展开/收起。
document.addEventListener('click', function (e) {
  var t = e.target && e.target.closest ? e.target.closest('[data-menu-toggle]') : null;
  var wrap = t ? t.parentNode : null;
  var menu = wrap ? wrap.querySelector('.menu') : null;
  var opening = !!t && !!menu && menu.hasAttribute('hidden');
  var menus = document.querySelectorAll('.menu');
  for (var i = 0; i < menus.length; i++) menus[i].setAttribute('hidden', '');
  if (opening) menu.removeAttribute('hidden');
});

// 本地时区渲染：把 data-epoch 毫秒时间按浏览器本地时区显示（无 JS 时服务端已输出 UTC 兜底）
function formatLocalTimes() {
  var list = document.querySelectorAll('[data-local-time]');
  for (var i = 0; i < list.length; i++) {
    var t = parseInt(list[i].getAttribute('data-epoch') || '', 10);
    if (!isNaN(t)) list[i].textContent = new Date(t).toLocaleString('zh-CN');
  }
}
document.addEventListener('DOMContentLoaded', formatLocalTimes);
document.addEventListener('htmx:afterSwap', formatLocalTimes);

// 冷却倒计时：读 data-cooldown-until（服务端 SSR 的绝对 ms 截止戳，见 src/views/index.ts
// formatRemaining，文案保持逐字符一致）。单一全局 setInterval，每次 tick 重新 querySelectorAll——
// HTMX 换片段后新行天然被下一拍扫到（无需重挂），脱离 DOM 的元素不再返回（无定时器泄漏）。
// 到 0 时整格替换为 `<span class="muted">-</span>`，与 SSR 空态一致。
function cooldownText(ms) {
  if (ms <= 0) return null;
  if (Math.ceil(ms / 1000) >= 100) return '冷却：' + Math.ceil(ms / 60000) + 'min';
  return '冷却：' + Math.ceil(ms / 1000) + 's';
}
function tickCooldowns() {
  var els = document.querySelectorAll('[data-cooldown-until]');
  for (var i = 0; i < els.length; i++) {
    var el = els[i];
    var until = parseInt(el.getAttribute('data-cooldown-until') || '', 10);
    if (isNaN(until)) continue;
    var remain = until - Date.now();
    if (remain <= 0) {
      var cell = el.closest('td');
      if (cell) cell.innerHTML = '<span class="muted">-</span>';
      continue;
    }
    var txt = cooldownText(remain);
    // 文案未变不写 DOM：冷却长时（如 12h 只到分钟档）前台 tick 每秒跑到，避免无谓写入
    if (el.textContent !== txt) el.textContent = txt;
  }
}
document.addEventListener('DOMContentLoaded', function () {
  tickCooldowns(); // 首屏立即刷一次，不等第一个间隔
  setInterval(tickCooldowns, 1000);
});
// 片段交换后 0ms 刷新，避免等下一拍（幂等：同一 tick 函数，不挂新实例）
document.addEventListener('htmx:afterSwap', tickCooldowns);
