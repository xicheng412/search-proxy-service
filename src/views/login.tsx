// 登录页模板：独立于 dashboard/keys 等 admin 页面；仅依赖公共 layout（header=false）。
// 无任何 inline style（间距由 static/admin.css 的 .auth-form / .form-stack 规则负责）。

import { layout } from "./index";

export function loginPage(error: boolean) {
  const err = error ? (
    <p class="form-error" role="alert">
      密码错误，请重试
    </p>
  ) : null;
  const body = (
    <div class="auth-card">
      <div class="auth-brand">
        <span class="brand-mark" aria-hidden="true"></span>Tavily Proxy
      </div>
      <h1 class="auth-title">Tavily Proxy 管理后台</h1>
      <p class="auth-sub">使用管理员密码登录</p>
      {err}
      <form class="form-stack auth-form" method="post" action="/admin/login">
        <label class="field" for="admin-password">
          <span class="field-label">管理员密码</span>
          <input
            class="input"
            id="admin-password"
            type="password"
            name="password"
            autofocus
            autocomplete="current-password"
            required
          />
        </label>
        <button class="btn btn-primary btn-block" type="submit">
          登录
        </button>
      </form>
    </div>
  );
  return layout("登录 · Tavily Proxy", body, { header: false, bodyClass: "auth-page" });
}
