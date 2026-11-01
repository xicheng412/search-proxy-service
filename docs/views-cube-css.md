# views/ CSS 组织约定（CUBE CSS）

后台管理页样式遵循 **CUBE CSS**（Composition / Utility / Block / Exception）组织。
后台样式唯一承载：**`static/admin.css`**（CUBE 分层注释照守；Cloudflare Static Assets 托管 + 默认缓存策略：改完 deploy，下一次刷新浏览器即见新版，无需 hash）；帮助页样式 **`static/help.css`**，独立于 CUBE 体系。

## 适用范围

- **适用**：`src/views/` 下用 `layout()` 渲染的后台页面（Tavily / Exa / 分发 Keys / Dashboard / 登录）。
- **不适用**：`src/views/help.ts` 是独立静态页、自带完整样式，自成一体；若要纳入本约定，需先把公共样式抽出来。

## 分层（`static/admin.css` 内按此顺序分区块注释）

| 层 | 管什么 | 现状类 |
|---|---|---|
| **Theme tokens** | 颜色/字号唯一事实源（CSS 变量） | `:root` / `:root[data-theme="dark"]`：`--bg/--surface/--surface-2/--surface-3/--border/--border-strong/--text/--text-secondary/--muted/--accent/--accent-contrast/--accent-soft/--ok/--warn/--bad(各带 -soft)/--focus/--series-tavily/--series-exa/--radius-*/--shadow-sm/--shadow-md/--font-*/--page-max/--topbar-h` |
| **Base elements** | 原生元素默认（无类） | `*`, `body`, `a`, `button`, `input[...]`, `select`, `textarea`, `table`, `code`, `pre`, `::selection`, `:focus-visible`, `[hidden]`, `@media (prefers-reduced-motion)` |
| **Composition** | 元素间布局关系（flex/grid/gap/wrap） | `.page`, `.page > .card + .card`（块间 20px 节奏）, `.page [id]`（锚点 scroll-margin）, `.page-header`, `.page-actions`, `.stats-grid`, `.dashboard-grid`, `.settings-grid`, `.form-grid`, `.signal-list`, `.toolbar`, `.toolbar-meta`, `.cluster`, `.row-actions`, `.inline-form`, `.table-wrap` |
| **Block** | 组件骨架（结构 + 自有视觉） | `.topbar/.topbar-inner`, `.brand/.brand-mark/.brand-name/.brand-tag`, `.nav/.nav-item`, `.topbar-actions`, `.icon-btn`, `.page-title/.page-desc`, `.card/.card-header/.card-actions/.card-title/.card-desc/.card-body/.card-note`, `.stat-card/.stat-top/.stat-name/.stat-num/.stat-meta/.stat-link`, `.signal-row/.signal-label`, `.status-dot`, `.badge`, `.btn`, `.field/.field-label/.input-wrap/.input/.field-unit/.field-hint`, `.data-table`, `.key-mask`, `.empty`, `.menu-wrap/.menu`, `.toast/.toast-region`, `.chart-card/.chart-box/.chart-legend/.legend-item/.legend-swatch*`, `.signals-card`, `.settings-group/.settings-title/.settings-desc/.settings-actions`, `.generate-row`, `.checkbox-field`, `.batch-bar`, `details.batch-add`, `.pagination/.page-btn`, `.auth-card/.auth-brand/.auth-title/.auth-sub`, `.plain/.plain-label`, `.form-error`, `.err` |
| **Utility** | 单一视觉、跨组件复用的原子类 | `.muted`, `.mono`, `.text-sm` |
| **Exception** | Block 的上下文变体 / 修饰 | `.nav-item.active`, `.badge-{neutral,ok,warn,bad}`, `.btn-{primary,secondary,ghost,danger}`, `.btn-sm`, `.btn-block`, `.input.input-sm`, `.theme-icon(-sun/-moon)`, `.status-dot.{ok,warn,bad}`, `.topbar-link`, `.settings-group + .settings-group` |
| **Responsive** | 窄屏变体，**恒在样式末尾** | `@media (max-width:900px)`、`@media (max-width:640px)` |

## 维护规则（硬性）

1. **新增布局 → Composition 类**：禁止在模板里内联 `display:flex/grid`、`gap`、`flex-wrap` 做重复的布局。同一布局第二处出现前先抽类。现有选择：
   - `.row-actions` / `.inline-form`：行内控件组（gap 6px、垂直居中）。
   - `.toolbar` / `.cluster`：信息行 + 操作按钮组。
   - `.form-grid`：`auto-fit, minmax(150px,1fr)` 表单字段网格。
2. **新增单一视觉 → Utility 类**：例如按钮尺寸统一走 `.btn-sm`（min-height 28px、padding 4px 9px），禁止再内联 `style`。
3. **新组件骨架 → Block 类**；**变体 → Exception 类**，用增类而非写死结构。
4. **内联 `style` 一律禁止**（`grep -R 'style="' src/views` 必须为 0）；一次性特殊布局若确需要，先加自定义 Utility/Block 类，不写内联。
5. **保持同类选择器的相对顺序**：同名特异的规则后者覆盖前者，重排时别乱动。`@media` 恒在末尾按序覆盖。
6. **CSS/JS 已抽入 `static/`（Cloudflare Static Assets 托管）**：新增样式优先复用 `static/admin.css` 的 CUBE 类；确需独立文件时先确认复用不足。改 `static/` 下文件需重新部署才生效。

## 简约而不是教条

规模到此为止不需要工具库级 composition（`.cluster/.switcher/.sidebar` 全家桶）或 utility-first 全覆盖。判据：**重复即抽，一次性也走类（不写内联）**。模板保持"直读 HTML"，抽象只落在确有成簇重复的地方。
