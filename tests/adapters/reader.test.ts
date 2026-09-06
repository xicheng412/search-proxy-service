// reader 协议转换纯函数单测（src/adapters/reader.ts）：
// 目标 URL 解析 / Tavily Extract 请求体 / 响应→纯文本转换 / 错误体。纯静态断言、零依赖。

import { describe, it, expect } from "vitest";
import {
  parseReaderTarget,
  buildExtractBody,
  toTextResponse,
  readerError,
} from "../../src/adapters/reader";

describe("parseReaderTarget", () => {
  it("剥离 /reader/ 前缀，返回目标 URL", () => {
    expect(parseReaderTarget("/reader/https://www.example.com")).toBe("https://www.example.com");
    expect(parseReaderTarget("/reader/https://example.com/a/b.html")).toBe("https://example.com/a/b.html");
  });

  it("percent-encode 恢复（目标自带 query 时调用方须整体编码）", () => {
    expect(parseReaderTarget("/reader/https%3A%2F%2Fexample.com%2Fa%3Fb%3Dc")).toBe(
      "https://example.com/a?b=c"
    );
  });

  it("缺目标 / 非 /reader 前缀 / 畸形 % 序列 → null", () => {
    expect(parseReaderTarget("/reader/")).toBeNull();
    expect(parseReaderTarget("/reader")).toBeNull();
    expect(parseReaderTarget("/search?q=x")).toBeNull();
    expect(parseReaderTarget("")).toBeNull();
    expect(parseReaderTarget("/reader/https%3A%zz")).toBeNull();
  });
});

describe("buildExtractBody", () => {
  it("单 URL + 固定 basic 深度", () => {
    expect(buildExtractBody("https://example.com")).toEqual({
      urls: ["https://example.com"],
      extract_depth: "basic",
    });
  });
});

describe("toTextResponse", () => {
  const URL = "https://example.com";

  it("目标命中 → 200 text/plain raw_content", async () => {
    const res = toTextResponse({ results: [{ url: URL, raw_content: "hello world" }] }, URL);
    expect(res).not.toBeNull();
    expect(res!.status).toBe(200);
    expect(res!.headers.get("content-type")).toContain("text/plain");
    expect(await res!.text()).toBe("hello world");
  });

  it("目标在 failed_results（确定性失败）→ 502 {error}，直接返回 Response 而非 null（不换 key）", async () => {
    const res = toTextResponse(
      { results: [], failed_results: [{ url: URL, error: "Target URL not found" }] },
      URL
    );
    expect(res).not.toBeNull();
    expect(res!.status).toBe(502);
    expect(await res!.json()).toEqual({
      error: `failed to fetch ${URL}: Target URL not found`,
    });
  });

  it("无该目标结果 / 畸形响应 → null（视为不可用，交重试核换 key）", () => {
    expect(toTextResponse({ results: [{ url: "https://other.com", raw_content: "x" }] }, URL)).toBeNull();
    expect(toTextResponse({ results: [{ url: URL, raw_content: "" }] }, URL)).toBeNull();
    expect(toTextResponse(null, URL)).toBeNull();
    expect(toTextResponse("garbage", URL)).toBeNull();
  });
});

describe("readerError", () => {
  it("统一 {error} JSON 格式", async () => {
    const res = readerError(400, "bad");
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ error: "bad" });
  });
});
