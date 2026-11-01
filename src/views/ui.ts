// 后台共用 UI primitives（只 import ./html；不 import ./index，避免循环依赖）。
// markup 契约见 admin-ui-redesign 计划 step 1；唯一的"字段"安全原语是 esc()。

import { esc } from "./html";

export type Tone = "neutral" | "ok" | "warn" | "bad";

const ICON_PATHS: Record<
  "sun" | "moon" | "copy" | "chevron-down" | "chevron-right" | "refresh" | "plus" | "logout" | "external",
  string
> = {
  sun: `<circle cx="12" cy="12" r="4"/><path d="M12 2v2"/><path d="M12 20v2"/><path d="m4.93 4.93 1.41 1.41"/><path d="m17.66 17.66 1.41 1.41"/><path d="M2 12h2"/><path d="M20 12h2"/><path d="m6.34 17.66-1.41 1.41"/><path d="m19.07 4.93-1.41 1.41"/>`,
  moon: `<path d="M12 3a6 6 0 0 0 9 9 9 9 0 1 1-9-9Z"/>`,
  copy: `<rect width="14" height="14" x="8" y="8" rx="2" ry="2"/><path d="M4 16c-1.1 0-2-.9-2-2V4c0-1.1.9-2 2-2h10c1.1 0 2 .9 2 2"/>`,
  "chevron-down": `<path d="m6 9 6 6 6-6"/>`,
  "chevron-right": `<path d="m9 18 6-6-6-6"/>`,
  refresh: `<path d="M3 12a9 9 0 0 1 9-9 9.75 9.75 0 0 1 6.74 2.74L21 8"/><path d="M21 3v5h-5"/><path d="M21 12a9 9 0 0 1-9 9 9.75 9.75 0 0 1-6.74-2.74L3 16"/><path d="M8 16H3v5"/>`,
  plus: `<path d="M5 12h14"/><path d="M12 5v14"/>`,
  logout: `<path d="M9 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h4"/><polyline points="16 17 21 12 16 7"/><line x1="21" x2="9" y1="12" y2="12"/>`,
  external: `<path d="M15 3h6v6"/><path d="M10 14 21 3"/><path d="M18 13v6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h6"/>`,
};

export function icon(
  name: "sun" | "moon" | "copy" | "chevron-down" | "chevron-right" | "refresh" | "plus" | "logout" | "external"
): string {
  return `<svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${ICON_PATHS[name]}</svg>`;
}

export function pageHeader(opts: {
  title: string;
  description?: string;
  actions?: string;
}): string {
  const desc = opts.description ? `<p class="page-desc">${esc(opts.description)}</p>` : "";
  const actions = opts.actions ? `<div class="page-actions">${opts.actions}</div>` : "";
  return `<div class="page-header"><div><h1 class="page-title">${esc(opts.title)}</h1>${desc}</div>${actions}</div>`;
}

export function card(opts: {
  title?: string;
  description?: string;
  actions?: string;
  body: string;
  className?: string;
  id?: string;
}): string {
  const head =
    opts.title !== undefined || opts.description !== undefined
      ? `<div><h2 class="card-title">${esc(opts.title ?? "")}</h2>${
          opts.description ? `<p class="card-desc">${esc(opts.description)}</p>` : ""
        }</div>`
      : "";
  const actions = opts.actions ? `<div class="card-actions">${opts.actions}</div>` : "";
  const header = head || actions ? `<div class="card-header">${head}${actions}</div>` : "";
  return `<section class="card${opts.className ? ` ${opts.className}` : ""}"${
    opts.id ? ` id="${esc(opts.id)}"` : ""
  }>${header}<div class="card-body">${opts.body}</div></section>`;
}

export function statCard(opts: {
  label: string;
  value: string | number;
  meta: string;
  href: string;
  tone?: Tone;
}): string {
  const dot = opts.tone ? `<span class="status-dot ${opts.tone}"></span>` : `<span class="status-dot"></span>`;
  return `<article class="card stat-card">
  <div class="stat-top"><span class="stat-name">${esc(opts.label)}</span>${dot}</div>
  <div class="stat-num">${esc(String(opts.value))}</div>
  <div class="stat-meta">${esc(opts.meta)}</div>
  <a class="stat-link" href="${esc(opts.href)}">进入管理 <span aria-hidden="true">→</span></a>
</article>`;
}

export function badge(label: string, tone: Tone = "neutral"): string {
  return `<span class="badge badge-${tone}">${esc(label)}</span>`;
}

export function field(opts: {
  label: string;
  name: string;
  value?: string | number;
  type?: "text" | "number" | "password";
  min?: number;
  step?: number;
  unit?: string;
  hint?: string;
  required?: boolean;
  placeholder?: string;
  autofocus?: boolean;
  autocomplete?: string;
}): string {
  const type = opts.type ?? "text";
  const attrs = [
    `id="field-${esc(opts.name)}"`,
    `type="${type}"`,
    `name="${esc(opts.name)}"`,
  ];
  if (opts.min !== undefined) attrs.push(`min="${opts.min}"`);
  if (opts.step !== undefined) attrs.push(`step="${opts.step}"`);
  if (opts.value !== undefined) attrs.push(`value="${esc(String(opts.value))}"`);
  if (opts.placeholder !== undefined) attrs.push(`placeholder="${esc(opts.placeholder)}"`);
  if (opts.required) attrs.push("required");
  if (opts.autofocus) attrs.push("autofocus");
  if (opts.autocomplete !== undefined) attrs.push(`autocomplete="${esc(opts.autocomplete)}"`);
  const unit = opts.unit ? `<span class="field-unit">${esc(opts.unit)}</span>` : "";
  const hint = opts.hint ? `<span class="field-hint">${esc(opts.hint)}</span>` : "";
  const wrapCls = opts.unit ? `input-wrap has-unit` : `input-wrap`;
  return `<label class="field" for="field-${esc(opts.name)}">
    <span class="field-label">${esc(opts.label)}</span>
    <span class="${wrapCls}"><input class="input" ${attrs.join(" ")}>${unit}</span>
    ${hint}
  </label>`;
}

export function emptyRow(colspan: number, message: string): string {
  return `<tr><td colspan="${Math.trunc(colspan)}"><div class="empty">${esc(message)}</div></td></tr>`;
}
