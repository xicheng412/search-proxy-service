// Tavily Keys 管理页模板（按确认与 Exa 各维护一份，路径/文案为本 provider 专用）。

import { CoreKey, Stats, maskKey } from "../domain";
import { esc, csrfField } from "./html";
import { badge, card, emptyRow, field, icon, pageHeader } from "./ui";
import {
  Pagination,
  formatRemaining,
  layout,
  paginationHtml,
  toast,
} from "./index";

export function tavilyPage(csrf: string, fragment: string): string {
  const body = `
${pageHeader({
  title: "Tavily Keys",
  description: "管理上游 Tavily 官方 key · 列表始终脱敏",
  actions: `<a class="btn btn-secondary btn-sm" href="#add-key">${icon("plus")}添加 Key</a>`,
})}
${card({
  title: "Key 列表",
  description: "当日成功/失败为上游调用尝试次数，UTC 00:00 起；429 与 400/404/422 不记。",
  body: `<div id="tavily-list">${fragment}</div>`,
})}
${card({
  id: "add-key",
  title: "添加 Tavily Key",
  body: tavilyEditFragment(csrf),
})}`;
  return layout("Tavily Keys · Tavily Proxy", body, { active: "tavily" });
}

export function tavilyListFragment(
  keys: CoreKey[],
  statsMap: Record<string, Stats>,
  csrf: string,
  now: number,
  pagination: Pagination,
  flash?: string,
  total: number | null = null
): string {
  const flashHtml = toast(flash);
  const rows = keys.length
    ? keys
        .map((k) => {
          const s = statsMap[k.id] ?? { success: 0, fail: 0 };
          const causeMap: Record<string, string> = {
            "post-use": "post-use 冷却",
            breaker: "熔断冷却",
            invalid: "疑似失效冷却",
            "rate-limit": "限流冷却",
          };
          const causeTitle = k.suspended_cause ? (causeMap[k.suspended_cause] ?? "冷却中") : "冷却中";
          const cooling =
            k.cooldown_until != null && k.cooldown_until > now
              ? `<span class="badge badge-warn" data-cooldown-until="${k.cooldown_until}" title="${causeTitle}">${formatRemaining(k.cooldown_until - now)}</span>`
              : `<span class="muted">-</span>`;
          const st =
            k.status === "enabled"
              ? badge("enabled", "ok")
              : badge("disabled", "neutral");
          return `<tr>
            <td><input type="checkbox" name="ids[]" value="${esc(k.id)}" form="batch-form" class="row-check"></td>
            <td><code class="key-mask">${esc(maskKey(k.key))}</code></td>
            <td>
              <form class="inline-form" hx-post="/admin/tavily/${esc(k.id)}/name" hx-target="#tavily-list"
                    hx-swap="innerHTML">
                ${csrfField(csrf)}
                <input class="input input-sm" type="text" name="name" value="${esc(k.name)}">
                <button class="btn btn-ghost btn-sm" type="submit">保存</button>
              </form>
            </td>
            <td>${st}</td>
            <td>${cooling}</td>
            <td class="num">${s.success}</td>
            <td class="num">${s.fail}</td>
            <td class="cell-actions">
              <div class="row-actions">
                <form hx-post="/admin/tavily/${esc(k.id)}/toggle" hx-target="#tavily-list"
                      hx-swap="innerHTML">
                  ${csrfField(csrf)}
                  <button class="btn btn-ghost btn-sm" type="submit">${k.status === "enabled" ? "停用" : "启用"}</button>
                </form>
                <form hx-post="/admin/tavily/${esc(k.id)}/delete" hx-target="#tavily-list"
                      hx-swap="innerHTML" hx-confirm="确认删除该 Tavily key？">
                  ${csrfField(csrf)}
                  <button class="btn btn-danger btn-sm" type="submit">删除</button>
                </form>
              </div>
            </td>
          </tr>`;
        })
        .join("")
    : emptyRow(8, "暂无 Tavily key，请先添加。");

  const batchBar = keys.length
    ? `<form id="batch-form" method="post" class="batch-bar">
        ${csrfField(csrf)}
        <span class="muted text-sm">已选 <span id="batch-count">0</span> 个</span>
        <button type="submit" formaction="/admin/tavily/batch-toggle" class="btn btn-secondary btn-sm" onclick="return requireSelection()">批量切换</button>
        <button type="submit" formaction="/admin/tavily/batch-delete" class="btn btn-danger btn-sm" onclick="return confirmDeleteBatch()">批量删除</button>
      </form>`
    : "";

  return `${flashHtml}
  ${batchBar}
  <div class="table-wrap">
    <table class="data-table">
      <thead><tr><th scope="col"><input type="checkbox" id="select-all" title="全选本页" aria-label="全选本页"></th><th scope="col">Key</th><th scope="col">备注</th><th scope="col">状态</th><th scope="col">冷却</th>
        <th scope="col" title="当日（UTC 00:00 起）该官方 key 的上游调用成功尝试数">当日成功</th>
        <th scope="col" title="当日（UTC 00:00 起）该官方 key 的上游调用失败尝试数">当日失败</th><th scope="col">操作</th></tr></thead>
      <tbody>${rows}</tbody>
    </table>
  </div>
  ${paginationHtml(pagination, keys.length > 0, "#tavily-list", total)}`;
}

export function tavilyEditFragment(csrf: string): string {
  return `
  <form class="form-grid" hx-post="/admin/tavily/add" hx-target="#tavily-list" hx-swap="innerHTML">
    ${csrfField(csrf)}
    ${field({ label: "Key", name: "key", placeholder: "tvly-xxx", required: true })}
    ${field({ label: "备注（可选）", name: "name" })}
    <label class="checkbox-field"><input type="checkbox" name="test" value="1"> 加入时验证</label>
    <button class="btn btn-primary btn-sm" type="submit">添加</button>
  </form>
  <details class="batch-add">
    <summary>批量添加</summary>
    <form hx-post="/admin/tavily/add/batch" hx-target="#tavily-list" hx-swap="innerHTML">
      ${csrfField(csrf)}
      <textarea name="keys" placeholder="多个 key 用逗号或换行分隔" rows="4" required></textarea>
      <div class="inline-form">
        <input class="input" type="text" name="name" placeholder="备注前缀（可选）">
        <button class="btn btn-secondary btn-sm" type="submit">批量添加</button>
      </div>
    </form>
  </details>`;
}
