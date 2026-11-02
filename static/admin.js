// 后台公共脚本：被 src/views/index.tsx 的 layout() 以 `<script src="/admin.js" defer>` 引用。
// 覆盖登录/管理页全部后台页面，负责主题切换、一键复制+全屏 toast、操作列下拉菜单、
// 本地时区渲染与冷却倒计时、批量操作守卫。

// ---------- 主题切换：写 tp-theme 到 localStorage，并广播 themechange（dashboard.js 监听） ----------
(function () {
  var root = document.documentElement;
  var btn = document.querySelector('[data-theme-toggle]');
  if (!btn) return;
  function current() { return root.dataset.theme === 'dark' ? 'dark' : 'light'; }
  function sync() {
    btn.setAttribute('aria-label', current() === 'dark' ? '切换到浅色模式' : '切换到深色模式');
  }
  sync();
  btn.addEventListener('click', function () {
    var next = current() === 'dark' ? 'light' : 'dark';
    root.dataset.theme = next;
    try { localStorage.setItem('tp-theme', next); } catch (e) {}
    sync();
    document.dispatchEvent(new CustomEvent('themechange', { detail: { theme: next } }));
  });
})();

// ---------- 全屏 toast：覆盖式提示（同一时间只保留一则） ----------
function showToast(message) {
  var region = document.getElementById('toast-region');
  if (!region) return;
  // 同一时间只保留一则在屏
  while (region.firstChild) region.removeChild(region.firstChild);
  var t = document.createElement('div');
  t.className = 'toast';
  t.textContent = message;
  region.appendChild(t);
  setTimeout(function () {
    if (t.parentNode) t.parentNode.removeChild(t);
  }, 1800);
}

// ---------- 一键复制：点击带 data-copy 的按钮，把完整 key 复制到剪贴板 ----------
document.addEventListener('click', function (e) {
  var btn = e.target && e.target.closest ? e.target.closest('[data-copy]') : null;
  if (!btn) return;
  var text = btn.getAttribute('data-copy') || '';
  if (!text) return;
  var orig = btn.getAttribute('data-label');
  if (orig === null) { orig = btn.textContent; btn.setAttribute('data-label', orig); }
  // 按钮内嵌图标（如复制图标的 SVG）：textContent 赋值会删除子节点，需在回馈后重新插回。
  var svg = btn.querySelector('svg');
  function restore() {
    btn.textContent = orig;
    if (svg && !btn.contains(svg)) btn.insertBefore(svg, btn.firstChild);
  }
  navigator.clipboard.writeText(text).then(function () {
    btn.textContent = '已复制';
    if (svg && !btn.contains(svg)) btn.insertBefore(svg, btn.firstChild);
    setTimeout(restore, 1200);
    showToast('已复制到剪贴板');
  }).catch(function () {
    btn.textContent = '复制失败';
    if (svg && !btn.contains(svg)) btn.insertBefore(svg, btn.firstChild);
    setTimeout(restore, 1200);
    showToast('复制失败');
  });
});

// ---------- 操作列「复制」下拉菜单：点按钮开/关，点外部任意处（含菜单项）关闭，Escape 关闭 ----------
function closeAllMenus() {
  var menus = document.querySelectorAll('.menu');
  for (var i = 0; i < menus.length; i++) {
    menus[i].setAttribute('hidden', '');
    var wrap = menus[i].parentNode;
    var trig = wrap && wrap.querySelector ? wrap.querySelector('[data-menu-toggle]') : null;
    if (trig) trig.setAttribute('aria-expanded', 'false');
  }
}
document.addEventListener('click', function (e) {
  var t = e.target && e.target.closest ? e.target.closest('[data-menu-toggle]') : null;
  var wrap = t ? t.parentNode : null;
  var menu = wrap ? wrap.querySelector('.menu') : null;
  var opening = !!t && !!menu && menu.hasAttribute('hidden');
  closeAllMenus();
  if (opening) {
    menu.removeAttribute('hidden');
    // .menu 是 position:fixed（避免被 .table-wrap 的 overflow 滚动容器裁剪），
    // 位置按触发按钮相对视口定位，并夹在视口内；贴近底边/右边时朝上/左翻。
    var r = t.getBoundingClientRect();
    var mw = menu.offsetWidth;
    var mh = menu.offsetHeight;
    var top = r.bottom + 6;
    if (top + mh > window.innerHeight - 4) top = Math.max(4, r.top - mh - 6);
    var left = Math.min(r.right - mw, window.innerWidth - mw - 4);
    if (left < 4) left = Math.max(4, Math.min(r.left, window.innerWidth - mw - 4));
    menu.style.top = top + 'px';
    menu.style.left = left + 'px';
    t.setAttribute('aria-expanded', 'true');
  }
});
// 滚动/缩放会移动触发按钮，fixed 菜单不再跟随 → 直接关闭（菜单是瞬态的）
document.addEventListener('scroll', closeAllMenus, true);
window.addEventListener('resize', closeAllMenus);
document.addEventListener('keydown', function (e) {
  if (e.key !== 'Escape') return;
  // 焦点在菜单项上时，Escape 关闭菜单会把焦点丢给 <body>；回收到触发按钮。
  var a = document.activeElement;
  var openMenu = a && a.closest ? a.closest('.menu') : null;
  var trig = openMenu && openMenu.parentNode ? openMenu.parentNode.querySelector('[data-menu-toggle]') : null;
  closeAllMenus();
  if (trig) trig.focus();
});

// ---------- 本地时区渲染：把 data-epoch 毫秒时间按浏览器本地时区显示（无 JS 时服务端已输出 UTC 兜底） ----------
function formatLocalTimes() {
  var list = document.querySelectorAll('[data-local-time]');
  for (var i = 0; i < list.length; i++) {
    var t = parseInt(list[i].getAttribute('data-epoch') || '', 10);
    if (!isNaN(t)) list[i].textContent = new Date(t).toLocaleString('zh-CN');
  }
}
document.addEventListener('DOMContentLoaded', formatLocalTimes);
document.addEventListener('htmx:afterSwap', formatLocalTimes);

// ---------- 冷却倒计时：读 data-cooldown-until（服务端 SSR 的绝对 ms 截止戳，见 src/views/index.tsx
// formatRemaining，文案保持逐字符一致）。单一全局 setInterval，每次 tick 重新 querySelectorAll——
// HTMX 换片段后新行天然被下一拍扫到（无需重挂），脱离 DOM 的元素不再返回（无定时器泄漏）。
// 到 0 时整格替换为 `<span class="muted">-</span>`，与 SSR 空态一致。 ----------
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

// ---------- 批量操作：本页复选框全选 + 计数 + 提交前守卫（批量切换须有选中；批量删除破坏性须确认数量） ----------
function batchSelectedCount() {
  return document.querySelectorAll('input[name="ids[]"]:checked').length;
}
function updateBatchCount() {
  var el = document.getElementById('batch-count');
  if (el) el.textContent = String(batchSelectedCount());
}
// 表头「全选本页」：勾选/取消本页全部行复选框（仅当前可见页，翻页即失）。
document.addEventListener('change', function (e) {
  var t = e.target;
  if (t && t.id === 'select-all') {
    var checked = t.checked;
    var boxes = document.querySelectorAll('input[name="ids[]"]');
    for (var i = 0; i < boxes.length; i++) boxes[i].checked = checked;
  }
  updateBatchCount();
});
document.addEventListener('DOMContentLoaded', updateBatchCount);
document.addEventListener('htmx:afterSwap', updateBatchCount);

// ---------- 提交守卫：切换须至少选中一个；删除为破坏性操作，确认数量后放行 ----------
function requireSelection() {
  if (batchSelectedCount() === 0) { alert('未选择任何 key'); return false; }
  return true;
}
function confirmDeleteBatch() {
  var n = batchSelectedCount();
  if (n === 0) { alert('未选择任何 key'); return false; }
  return confirm('确认删除选中的 ' + n + ' 个 key？');
}
// 批量按钮用 data-batch-submit 标记（模板不再写行内 onclick）；守卫失败时阻止表单提交。
document.addEventListener('click', function (e) {
  var btn = e.target && e.target.closest ? e.target.closest('[data-batch-submit]') : null;
  if (!btn) return;
  var ok = btn.getAttribute('data-batch-submit') === 'delete'
    ? confirmDeleteBatch()
    : requireSelection();
  if (!ok) e.preventDefault();
});
