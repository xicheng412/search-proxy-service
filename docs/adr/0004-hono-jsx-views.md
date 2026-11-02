# ADR-0004: 管理后台视图改用 Hono JSX（纯 SSR）

**Status**: accepted

管理后台的服务端视图从手写字符串模板迁移到 Hono JSX（`src/views/*.tsx`），以组件/children 组合替代 `esc()` + 字符串拼接，降低转义与属性拼装的维护成本。HTMX 集成、`static/dashboard.js` 与 `help.ts` 保持不变；`static/admin.js` 仅新增 `data-batch-submit` 事件委托（见决策 5）；不引入客户端 hydration、SPA 或独立前端构建步骤。

## 上下文

- `src/views/` 原有约 950 行字符串模板、61 处 `esc()`、204 处插值；转义正确性依赖每个调用点，属性顺序与空白也被测试钉死。
- UI 基础件（`ui.tsx`）已经是"函数 + typed opts"，但没有 children 组合能力，`body` / `actions` 只能是字符串。
- 已验证：`tsc`（`jsx: react-jsx` + `jsxImportSource: hono/jsx`）、wrangler dry-run、vitest 都能在当前 `@cloudflare/workers-types` 环境下处理 `.tsx`，无需新增依赖或构建脚本。

## 决策

1. 仅迁移 admin 视图到 JSX；`help.ts` 是独立的静态长文页面，`<pre>` 与实体/JSON 示例在 JSX 中可读性更差，保留字符串模板。
2. 视图函数返回 JSX（`HtmlEscapedString`/`Child`），路由仍用 `c.html(...)`；测试统一 `String(node)` 后做语义断言。
3. 只在两处使用 `dangerouslySetInnerHTML`（主题引导脚本、Dashboard 两段 JSON），另用 `raw()` 输出 doctype；其余全部走 JSX 自动转义。
4. Tavily/Exa 管理页的重复布局抽到 `views/upstream-keys.tsx`，`views/{tavily,exa}.tsx` 只保留 provider 配置；仍保留每个 provider 独立的路由/配置文件，符合 architecture §4.2 的扩展路径。
5. 批量操作的 `onclick` 移入 `static/admin.js` 的 `data-batch-submit` 事件委托，模板不再写行内 JS。

## 考虑过的替代方案

- **保留字符串模板**：改动最小，但转义与组合问题继续由每个调用点承担。
- **`hono/html` tagged template**：也自动转义且无需 TSX 工具链，但仍没有 children/组件组合，`body`/`actions` 仍是字符串；适合只解决转义安全的场景。
- **客户端框架（Preact/React）**：会引入构建链与 hydration，和现有 HTMX 架构冲突，明确不做。

## 代价与约束

- `tsconfig.json` 必须包含 `src/**/*.tsx` 并设置 JSX 选项；`skipLibCheck: true` 成为 Hono JSX 类型（引用 DOM 全局）在当前 workers-types 环境下的必要条件。
- JSX 输出会改变属性顺序、boolean 属性形态与元素间空白；测试用语义子串断言，但仍固定关键属性顺序（改 prop 顺序需同步断言），不要求逐字节兼容。
- `String(jsx)` 会把已转义对象变成普通字符串，再次插入 JSX 会被二次转义；视图组合必须传 `Child`/JSX，禁止把渲染结果再拼进模板字符串。
- 新增 provider 时仍按 architecture §4.2 增加 admin 路由与 `views/<name>.tsx` 配置；共享布局不再复制。
