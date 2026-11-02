// 上游 Keys 管理页的共享 JSX 实现。
// 每个 provider 只保留一份配置（文案 / 路径 / 容器 id），布局与行为在此单点维护；
// 新增 provider 时仍按 architecture §4.2 增加 admin 路由 + provider 配置，不改本文件的分支。

import type { Child } from "hono/jsx";
import { CoreKey, Stats, maskKey } from "../domain";
import { csrfField } from "./html";
import { badge, card, emptyRow, field, icon, pageHeader } from "./ui";
import {
  Pagination,
  formatRemaining,
  layout,
  paginationHtml,
  toast,
} from "./index";
import type { NavKey } from "./index";

export interface UpstreamKeysViewConfig {
  label: string;
  docTitle: string;
  pageTitle: string;
  description: string;
  keyPlaceholder: string;
  batchKeyPlaceholder: string;
  errorsNote: string;
  listId: string;
  basePath: string;
  active: NavKey;
  emptyMessage: string;
  deleteConfirm: string;
}

export function upstreamKeysPage(
  cfg: UpstreamKeysViewConfig,
  csrf: string,
  fragment: Child
) {
  const body = (
    <>
      {pageHeader({
        title: cfg.pageTitle,
        description: cfg.description,
        actions: (
          <a class="btn btn-secondary btn-sm" href="#add-key">
            {icon("plus")}添加 Key
          </a>
        ),
      })}
      {card({
        title: "Key 列表",
        description: cfg.errorsNote,
        body: <div id={cfg.listId}>{fragment}</div>,
      })}
      {card({
        id: "add-key",
        title: `添加 ${cfg.label} Key`,
        description: "支持单个添加与批量添加；批量导入会自动跳过已存在的 key。",
        body: upstreamEditFragment(cfg, csrf),
      })}
    </>
  );
  return layout(cfg.docTitle, body, { active: cfg.active });
}

export function upstreamListFragment(
  cfg: UpstreamKeysViewConfig,
  keys: CoreKey[],
  statsMap: Record<string, Stats>,
  csrf: string,
  now: number,
  pagination: Pagination,
  flash?: string,
  total: number | null = null
) {
  const rows: Child = keys.length
    ? keys.map((k) => {
        const s = statsMap[k.id] ?? { success: 0, fail: 0 };
        const causeMap: Record<string, string> = {
          "post-use": "post-use 冷却",
          breaker: "熔断冷却",
          invalid: "疑似失效冷却",
          "rate-limit": "限流冷却",
        };
        const causeTitle = k.suspended_cause
          ? (causeMap[k.suspended_cause] ?? "冷却中")
          : "冷却中";
        const cooling =
          k.cooldown_until != null && k.cooldown_until > now ? (
            <span
              class="badge badge-warn"
              data-cooldown-until={k.cooldown_until}
              title={causeTitle}
            >
              {formatRemaining(k.cooldown_until - now)}
            </span>
          ) : (
            <span class="muted">-</span>
          );
        const st =
          k.status === "enabled"
            ? badge("enabled", "ok")
            : badge("disabled", "neutral");
        return (
          <tr>
            <td>
              <input
                type="checkbox"
                name="ids[]"
                value={k.id}
                form="batch-form"
                class="row-check"
              />
            </td>
            <td>
              <code class="key-mask">{maskKey(k.key)}</code>
            </td>
            <td>
              <form
                class="inline-form"
                hx-post={`${cfg.basePath}/${k.id}/name`}
                hx-target={`#${cfg.listId}`}
                hx-swap="innerHTML"
              >
                {csrfField(csrf)}
                <input class="input input-sm" type="text" name="name" value={k.name} />
                <button class="btn btn-ghost btn-sm" type="submit">
                  保存
                </button>
              </form>
            </td>
            <td>{st}</td>
            <td>{cooling}</td>
            <td class="num">{s.success}</td>
            <td class="num">{s.fail}</td>
            <td class="cell-actions">
              <div class="row-actions">
                <form
                  hx-post={`${cfg.basePath}/${k.id}/toggle`}
                  hx-target={`#${cfg.listId}`}
                  hx-swap="innerHTML"
                >
                  {csrfField(csrf)}
                  <button class="btn btn-ghost btn-sm" type="submit">
                    {k.status === "enabled" ? "停用" : "启用"}
                  </button>
                </form>
                <form
                  hx-post={`${cfg.basePath}/${k.id}/delete`}
                  hx-target={`#${cfg.listId}`}
                  hx-swap="innerHTML"
                  hx-confirm={cfg.deleteConfirm}
                >
                  {csrfField(csrf)}
                  <button class="btn btn-danger btn-sm" type="submit">
                    删除
                  </button>
                </form>
              </div>
            </td>
          </tr>
        );
      })
    : emptyRow(8, cfg.emptyMessage);

  const batchBar = keys.length ? (
    <form id="batch-form" method="post" class="batch-bar">
      {csrfField(csrf)}
      <span class="muted text-sm">
        已选 <span id="batch-count">0</span> 个
      </span>
      <button
        type="submit"
        formaction={`${cfg.basePath}/batch-toggle`}
        class="btn btn-secondary btn-sm"
        data-batch-submit="toggle"
      >
        批量切换
      </button>
      <button
        type="submit"
        formaction={`${cfg.basePath}/batch-delete`}
        class="btn btn-danger btn-sm"
        data-batch-submit="delete"
      >
        批量删除
      </button>
    </form>
  ) : null;

  return (
    <>
      {toast(flash)}
      {batchBar}
      <div class="table-wrap">
        <table class="data-table">
          <thead>
            <tr>
              <th scope="col">
                <input
                  type="checkbox"
                  id="select-all"
                  title="全选本页"
                  aria-label="全选本页"
                />
              </th>
              <th scope="col">Key</th>
              <th scope="col">备注</th>
              <th scope="col">状态</th>
              <th scope="col">冷却</th>
              <th
                scope="col"
                title="当日（UTC 00:00 起）该官方 key 的上游调用成功尝试数"
              >
                当日成功
              </th>
              <th
                scope="col"
                title="当日（UTC 00:00 起）该官方 key 的上游调用失败尝试数"
              >
                当日失败
              </th>
              <th scope="col">操作</th>
            </tr>
          </thead>
          <tbody>{rows}</tbody>
        </table>
      </div>
      {paginationHtml(pagination, keys.length > 0, `#${cfg.listId}`, total)}
    </>
  );
}

export function upstreamEditFragment(cfg: UpstreamKeysViewConfig, csrf: string) {
  return (
    <div class="add-methods">
      <section class="add-method" aria-labelledby="add-single-title">
        <div class="add-method-head">
          <h3 class="add-method-title" id="add-single-title">
            单个添加
          </h3>
          <p class="add-method-desc">粘贴一个官方 key，可先验证再保存。</p>
        </div>
        <form
          class="form-stack"
          hx-post={`${cfg.basePath}/add`}
          hx-target={`#${cfg.listId}`}
          hx-swap="innerHTML"
        >
          {csrfField(csrf)}
          <div class="add-fields">
            {field({
              label: "Key",
              name: "key",
              placeholder: cfg.keyPlaceholder,
              required: true,
            })}
            {field({ label: "备注（可选）", name: "name" })}
          </div>
          <div class="add-method-actions">
            <label class="checkbox-field">
              <input type="checkbox" name="test" value="1" /> 添加前验证
              <span class="field-hint">（消耗一次上游请求）</span>
            </label>
            <button class="btn btn-primary" type="submit">
              添加
            </button>
          </div>
        </form>
      </section>

      <section class="add-method" aria-labelledby="add-batch-title">
        <div class="add-method-head">
          <h3 class="add-method-title" id="add-batch-title">
            批量添加
          </h3>
          <p class="add-method-desc">
            每行一个 key，也支持逗号分隔；已存在的 key 会自动跳过。
          </p>
        </div>
        <form
          class="form-stack"
          hx-post={`${cfg.basePath}/add/batch`}
          hx-target={`#${cfg.listId}`}
          hx-swap="innerHTML"
        >
          {csrfField(csrf)}
          <label class="field" for="batch-keys">
            <span class="field-label">Keys</span>
            <textarea
              id="batch-keys"
              name="keys"
              rows={5}
              placeholder={cfg.batchKeyPlaceholder}
              required
            ></textarea>
          </label>
          <div class="add-method-actions">
            <label class="field add-prefix" for="batch-name-prefix">
              <span class="field-label">备注前缀（可选）</span>
              <input
                class="input"
                id="batch-name-prefix"
                type="text"
                name="name"
                placeholder="prod，按顺序自动编号"
              />
            </label>
            <button class="btn btn-secondary" type="submit">
              批量添加
            </button>
          </div>
        </form>
      </section>
    </div>
  );
}
