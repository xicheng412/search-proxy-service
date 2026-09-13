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
