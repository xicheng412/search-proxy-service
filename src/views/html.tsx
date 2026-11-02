// 公共安全原语。
// - JSX 视图：转义由 hono/jsx 运行时负责，不要手工 esc()。
// - 非 JSX 模板（目前只有 help.ts 的静态页）：仍用 esc() 拼字符串。
// - csrfField 是唯一 CSRF 隐藏字段来源，输出 JSX（不要再拼成裸 HTML 字符串）。

export function esc(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

export function csrfField(token: string) {
  return <input type="hidden" name="csrf_token" value={token} />;
}
