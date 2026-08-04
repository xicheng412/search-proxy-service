// Tavily Keys 管理页模板（按确认与 Exa 各维护一份，路径/文案为本 provider 专用）。

import { TavilyKey, TavilyStats, maskKey } from "../domain";
import { esc, csrfField, layout } from "./index";

export function tavilyPage(csrf: string, fragment: string): string {
  const body = `
<section class="card">
  <h2>Tavily Keys · 管理</h2>
  <div id="tavily-list">${fragment}</div>
</section>
<input type="hidden" id="csrf" value="${esc(csrf)}">`;
  return layout("Tavily Keys · Tavily Proxy", body, { active: "tavily" });
}

export function tavilyListFragment(
  keys: TavilyKey[],
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
            <td>
              <form hx-post="/admin/tavily/${esc(k.id)}/name" hx-target="#tavily-list"
                    hx-swap="innerHTML" style="display:flex;gap:4px;align-items:center;">
                ${csrfField(csrf)}
                <input type="text" name="name" value="${esc(k.name)}"
                  style="width:110px;padding:4px 6px;">
                <button class="ghost" type="submit" style="padding:3px 8px;">保存</button>
              </form>
            </td>
            <td>${st}</td>
            <td>${cooling}</td>
            <td>${s.success}</td>
            <td>${s.fail}</td>
            <td>
              <form hx-post="/admin/tavily/${esc(k.id)}/toggle" hx-target="#tavily-list"
                    hx-swap="innerHTML" style="display:inline;">
                ${csrfField(csrf)}
                <button class="ghost" type="submit">${k.status === "enabled" ? "停用" : "启用"}</button>
              </form>
              <form hx-post="/admin/tavily/${esc(k.id)}/delete" hx-target="#tavily-list"
                    hx-swap="innerHTML" hx-confirm="确认删除该 Tavily key？" style="display:inline;">
                ${csrfField(csrf)}
                <button class="danger" type="submit">删除</button>
              </form>
            </td>
          </tr>`;
        })
        .join("")
    : `<tr><td colspan="7" class="muted">暂无 Tavily key，请先添加。</td></tr>`;

  return `${flashHtml}
  <form class="row" hx-post="/admin/tavily/add" hx-target="#tavily-list" hx-swap="innerHTML">
    ${csrfField(csrf)}
    <input type="text" name="name" placeholder="备注（如：主 key）" required>
    <input type="text" name="key" placeholder="tvly-xxx" required>
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

