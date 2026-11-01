// 公共转义与 CSRF 字段（HTML 安全原语的唯一来源；所有 view 从本文件导入）。
// 与 src/views/index.ts 历史实现逐字符一致，不改变转义规则。

export function esc(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

export function csrfField(token: string): string {
  return `<input type="hidden" name="csrf_token" value="${esc(token)}">`;
}
