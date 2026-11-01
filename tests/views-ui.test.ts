// UI primitives 的安全/契约点：pageHeader 的 title/description 必须转义；
// field 的 id 派生、属性顺序子串与 unit 输出必须稳定（既有模板测试依赖这些子串）。

import { describe, it, expect } from "vitest";
import { pageHeader, field } from "../src/views/ui";
import { esc, csrfField } from "../src/views/html";

describe("pageHeader 转义", () => {
  it("title/description 中的 < 与 & 被转义，不输出原始字符", () => {
    const html = pageHeader({ title: "<x>", description: "&" });
    expect(html).toContain("&lt;x&gt;");
    expect(html).toContain("&amp;");
    expect(html).not.toContain("<x>");
    expect(html).not.toContain(">x<");
  });
});

describe("field 属性契约", () => {
  it("同时包含 id 派生、name/min/value 子串与 unit 输出", () => {
    const html = field({
      label: "间隔",
      name: "intervalMs",
      value: 3000,
      min: 100,
      unit: "ms",
      required: true,
    });
    expect(html).toContain('id="field-intervalMs"');
    expect(html).toContain('name="intervalMs" min="100" value="3000"');
    expect(html).toContain('<span class="field-unit">ms</span>');
    expect(html).toContain("required");
  });
});

describe("html.ts 原语", () => {
  it("esc 逐字符转义五个字符", () => {
    expect(esc("&<>\"'")).toBe("&amp;&lt;&gt;&quot;&#39;");
  });

  it("csrfField 输出 name/value 且 value 已转义", () => {
    expect(csrfField("a<b")).toBe(
      `<input type="hidden" name="csrf_token" value="a&lt;b">`
    );
  });
});
