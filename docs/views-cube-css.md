# views/ CSS 组织约定（CUBE CSS）

后台管理页样式遵循 **CUBE CSS**（Composition / Utility / Block / Exception）组织。
后台样式唯一承载：**`static/admin.css`**（CUBE 分层注释照守；Cloudflare Static Assets 托管 + 默认缓存策略：改完 deploy，下一次刷新浏览器即见新版，无需 hash）；帮助页样式 **`static/help.css`**，独立于 CUBE 体系。

## 适用范围

- **适用**：`src/views/` 下用 `layout()` 渲染的后台页面（Tavily / Exa / 分发 Keys / Dashboard / 登录）。
- **不适用**：`src/views/help.ts` 是独立静态页、自带完整样式，自成一体；若要纳入本约定，需先把公共样式抽出来。

## 分层（`static/admin.css` 内按此顺序分区块注释）

| 层 | 管什么 | 现状类 |
|---|---|---|
| **Theme tokens** | 颜色/字号唯一事实源（CSS 变量） | `:root { --bg/--card/--line/--txt/--muted/--accent/--ok/--bad }` |
| **Base elements** | 原生元素默认（无类） | `*`, `body`, `button`, `input[...]`, `table/th/td`, `a` |
| **Composition** | 元素间布局关系（flex/grid/gap/wrap） | `.hstack`, `.pagination`, `form.row`, `.stats`, `.dash-main`, `.dash-rail`, `.header-actions`, `.wrap > .card + .card` |
| **Block** | 组件骨架（结构 + 自有视觉） | `.wrap`, `header`, `.nav/.nav-item`, `.card`, `.stat`, `.btn`, `.badge`, `.menu`, `.plain`, `.toast`, `pre.code` |
| **Utility** | 单一视觉、跨组件复用的原子类 | `.muted`, `.hint`, `.err`, `.hl`, `.btn-sm` |
| **Exception** | Block 的上下文变体 / 修饰 | `.nav-item.active`, `.badge.ok/.off/.warn`, `button.ghost`, `button.danger`, `.row.center`, `.dash-rail .card.stat`, `.dash-main .card.chart` |
| **Responsive** | 窄屏变体，**恒在样式末尾** | `@media (max-width:800px)` |

## 维护规则（硬性）

1. **新增布局 → Composition 类**：禁止在模板里内联 `display:flex/grid`、`gap`、`flex-wrap` 做重复的布局。同一布局第二处出现前先抽类。现有选择：
   - `.hstack`：横向按钮组 / 内联控件组（gap 4px、允许换行、垂直居中）。
   - `.pagination`：分页条（gap 8px）。
   - `form.row`：表单字段行（gap 8px、允许换行）。
2. **新增单一视觉 → Utility 类**：例如按钮尺寸统一走 `.btn-sm`（padding `3px 8px`），禁止再内联 `style="padding:3px 8px;"`。
3. **新组件骨架 → Block 类**；**变体 → Exception 类**，用增类而非写死结构。
4. **内联 `style` 仅允许一次性特殊布局**（如 dist 页顶部「复制 base url」行的右对齐 + 负 margin hack）。一个内联写法重复出现就是抽类的信号。
5. **保持同特异性选择器的相对顺序**：同名特异的规则后者覆盖前者，重排时别乱动。已确认的安全点：`.stat .stat-num` 必须在 `.dash-rail .stat-num` 之后；`.dash-rail .card.stat`（12px）与 `@media` 内同款（10px）靠 `@media` 恒在末尾保证窄屏生效。
6. **CSS/JS 已抽入 `static/`（Cloudflare Static Assets 托管）**：新增样式优先复用 `static/admin.css` 的 CUBE 类；确需独立文件时先确认复用不足。改 `static/` 下文件需重新部署才生效。

## 简约而不是教条

规模到此为止不需要工具库级 composition（`.cluster/.switcher/.sidebar` 全家桶）或 utility-first 全覆盖。判据：**重复即抽，一次性可留内联**。模板保持"直读 HTML"，抽象只落在确有成簇重复的地方。
