// 登录页模板：独立于 dashboard/keys 等 admin 页面；仅依赖公共 layout（header=false）。

import { layout } from "./index";

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