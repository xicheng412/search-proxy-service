// 能力×协议矩阵单测：锁定 "capability 是一等概念" 的结构不变量。
// 纯静态断言、零依赖——直接读 providers/*.ts 的描述符，不触任何运行时/env。
// 覆盖的语义契约：
//   - Search 是基础能力，每个 provider 必须落地（/search 与 searxng 都依赖它）；
//   - searxng 协议只能落在 Search 能力上（"searxng 是能力的延伸，不是能力本身"）；
//   - exa 不声明 Extract → /extract 上它是 404 的来源；
//   - 每个声明的 Surface 非退化（有 path、开放至少一个协议）。
// 刻意不断言 "searxng 只在 tavily"：那是当前实现覆盖，不是不变量。

import { describe, it, expect } from "vitest";
import { TAVILY, EXA, PROVIDERS } from "../src/providers";

describe("能力×协议矩阵", () => {
  it("每个 provider 都落地 Search（基础能力）", () => {
    for (const provider of Object.values(PROVIDERS)) {
      expect(provider.capabilities.search).toBeDefined();
    }
  });

  it("searxng 永不落在 Search 以外的能力上", () => {
    for (const provider of Object.values(PROVIDERS)) {
      Object.entries(provider.capabilities).forEach(([cap, surface]) => {
        if (surface.protocols.includes("searxng")) expect(cap).toBe("search");
      });
    }
  });

  it("exa 不声明 Extract（/extract → exa 404 的来源）", () => {
    expect(EXA.capabilities.extract).toBeUndefined();
  });

  it("tavily 的 Search 同时开放 native 与 searxng", () => {
    expect(TAVILY.capabilities.search!.protocols).toContain("native");
    expect(TAVILY.capabilities.search!.protocols).toContain("searxng");
  });

  it("每个声明的 Surface 非退化（有 path、开放至少一个协议）", () => {
    for (const provider of Object.values(PROVIDERS)) {
      for (const surface of Object.values(provider.capabilities)) {
        expect(surface.path).toBeTruthy();
        expect(surface.protocols.length).toBeGreaterThan(0);
      }
    }
  });
});
