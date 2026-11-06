import { describe, it, expect } from "vitest";
import { parseDistKey } from "../src/domain";

describe("parseDistKey 复合前缀解析", () => {
  it.each([
    ["tavily-abc", { protocol: "native", provider: "tavily", apiKey: "abc" }],
    ["exa-abc", { protocol: "native", provider: "exa", apiKey: "abc" }],
    ["searxng-tavily-abc", { protocol: "searxng", provider: "tavily", apiKey: "abc" }],
    ["reader-tavily-abc", { protocol: "reader", provider: "tavily", apiKey: "abc" }],
  ])("%s 正向解析", (token, expected) => {
    expect(parseDistKey(token)).toEqual(expected);
  });

  it("复合前缀大小写不敏感，apiKey 保留大小写", () => {
    expect(parseDistKey("TAVILY-AbC")).toEqual({
      protocol: "native",
      provider: "tavily",
      apiKey: "AbC",
    });
    expect(parseDistKey("SearXNG-Tavily-AbC")).toEqual({
      protocol: "searxng",
      provider: "tavily",
      apiKey: "AbC",
    });
    expect(parseDistKey("Reader-Tavily-AbC")).toEqual({
      protocol: "reader",
      provider: "tavily",
      apiKey: "AbC",
    });
  });

  it.each([
    "tavily",
    "-abc",
    "tavily-",
    "searxng-exa-x",
    "bogus-abc",
    "tavily-ab-cd",
  ])("畸形输入 %s → null", (token) => {
    expect(parseDistKey(token)).toBeNull();
  });
});
