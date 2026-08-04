// Exa Keys 管理页模板（按确认与 Tavily 各维护一份，路径/文案为本 provider 专用）。

import { ExaKey, TavilyStats, maskKey } from "../kv";
import { esc, csrfField, layout } from "./index";

export function exaPage(csrf: string, fragment: string): string {
  const body = `
<section class="card">
  <h2>Exa Keys · 管理</h2>
  <div id="exa-list">${fragment}</div>
</section>
<input type="hidden" id="csrf" value="${esc(csrf)}">`;
  return layout("Exa Keys · Tavily Proxy", body, { active: "exa" });
}

export function exaListFragment(
  keys: ExaKey[],
  statsMap: Record<string, TavilyStats>,
  csrf: string,
  now: number,
  flash?: string
): string {
  const flashHtml = flash ? `<div class="toast" style="margin-bottom:8px;">${esc(flash)}</div>` : "";
  const rows = keys.length
    ? keys
        .map((k) => {
          const s = statsMap[k.id] ?? { success: 0, fail: 0 };
          const cooling =
            k.cooldown_until != null && k.cooldown_until > now
              ? `<span class="badge warn">冷却中</span>`
              : `<span class="muted">-</span>`;
          const st =
            k.status === "enabled"
              ? `<span class="badge ok">enabled</span>`
              : `<span class="badge off">disabled</span>`;
          return `<tr>
            <td>${esc(maskKey(k.key))}</td>
            <td>${esc(k.name)}</td>
            <td>${st}</td>
            <td>${cooling}</td>
            <td>${s.success}</td>
            <td>${s.fail}</td>
            <td>
              <form hx-post="/admin/exa/${esc(k.id)}/toggle" hx-target="#exa-list"
                    hx-swap="innerHTML" style="display:inline;">
                ${csrfField(csrf)}
                <button class="ghost" type="submit">${k.status === "enabled" ? "停用" : "启用"}</button>
              </form>
              <form hx-post="/admin/exa/${esc(k.id)}/delete" hx-target="#exa-list"
                    hx-swap="innerHTML" hx-confirm="确认删除该 Exa key？" style="display:inline;">
                ${csrfField(csrf)}
                <button class="danger" type="submit">删除</button>
              </form>
            </td>
          </tr>`;
        })
        .join("")
    : `<tr><td colspan="7" class="muted">暂无 Exa key，请先添加。</td></tr>`;

  return `${flashHtml}
  <form class="row" hx-post="/admin/exa/add" hx-target="#exa-list" hx-swap="innerHTML">
    ${csrfField(csrf)}
    <input type="text" name="name" placeholder="备注（如：主 key）" required>
    <input type="text" name="key" placeholder="Exa API key" required>
    <label class="muted" style="align-self:center;font-size:12px;white-space:nowrap;">
      <input type="checkbox" name="test" value="1" style="vertical-align:middle;"> 加入时验证
    </label>
    <button type="submit">添加</button>
  </form>
  <table>
    <thead><tr><th>Key</th><th>备注</th><th>状态</th><th>冷却</th>
      <th>当日成功</th><th>当日失败</th><th>操作</th></tr></thead>
    <tbody>${rows}</tbody>
  </table>`;
}

export function exaAddResult(
  ctx: { error?: string; mask?: string }
): string {
  if (ctx.error) {
    return `<div class="err" style="margin-bottom:8px;">${esc(ctx.error)}</div>`;
  }
  return `<div class="toast" style="margin-bottom:8px;">已添加 ${esc(ctx.mask ?? "")} 并验证通过</div>`;
}
