// UI primitives 的安全/契约点：pageHeader 的 title/description 必须转义；
// field 的 id 派生、属性顺序子串与 unit 输出必须稳定（既有模板测试依赖这些子串）。

import { describe, it, expect } from "vitest";
import { card, pageHeader, field } from "../src/views/ui";
import { esc, csrfField } from "../src/views/html";

/** JSX 视图返回 HtmlEscapedString 对象；测试统一转成字符串再断言。 */
const render = (node: unknown) => String(node);

describe("pageHeader 转义", () => {
  it("title/description 中的 < 与 & 被转义，不输出原始字符", () => {
    const html = render(pageHeader({ title: "<x>", description: "&" }));
    expect(html).toContain("&lt;x&gt;");
    expect(html).toContain("&amp;");
    expect(html).not.toContain("<x>");
    expect(html).not.toContain(">x<");
  });
});

describe("JSX 组合", () => {
  it("嵌套 JSX body 只转义一次，不会被 String 化后二次转义", () => {
    const html = render(card({ body: pageHeader({ title: "<x>" }) }));
    expect(html).toContain('<h1 class="page-title">&lt;x&gt;</h1>');
    expect(html).not.toContain("&amp;lt;");
  });
});

describe("field 属性契约", () => {
  it("同时包含 id 派生、name/min/value 子串与 unit 输出", () => {
    const html = render(
      field({
        label: "间隔",
        name: "intervalMs",
        value: 3000,
        min: 100,
        unit: "ms",
        required: true,
      })
    );
    expect(html).toContain('id="field-intervalMs"');
    expect(html).toContain('name="intervalMs" min="100" value="3000"');
    expect(html).toContain('<span class="field-unit">ms</span>');
    expect(html).toContain("required");
  });
});

describe("html.tsx 原语", () => {
  it("esc 逐字符转义五个字符（仅非 JSX 模板使用）", () => {
    expect(esc("&<>\"'")).toBe("&amp;&lt;&gt;&quot;&#39;");
  });

  it("csrfField 输出 hidden input 且 value 已转义", () => {
    const html = render(csrfField("a<b"));
    expect(html).toContain('<input type="hidden" name="csrf_token" value="a&lt;b"');
    expect(html).not.toContain('value="a<b"');
  });
});
