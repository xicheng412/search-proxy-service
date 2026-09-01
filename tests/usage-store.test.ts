// 用量分发统计批量读取 + 30s 缓存 + pending 叠加的可执行验证。
// 使用 fake D1（prepare/all），不连接真实 Cloudflare 资源。

import { describe, it, expect } from "vitest";
import { createUsageStore } from "../src/usage-store";
import { hourKey } from "../src/domain";
import type { Env } from "../src/types";

// fake D1：返回固定的已聚合行（等价真实 SQLite GROUP BY 后的结果），并统计 all() 调用次数。
function makeFakeDb(rows: Record<string, unknown>[]) {
  let queries = 0;
  const db = {
    prepare() {
      return {
        bind() {
          return {
            async all() {
              queries += 1;
              return { results: rows, success: true } as never;
            },
          };
        },
      };
    },
  };
  return { db, count: () => queries };
}

const seedRows = [
  { scope: "key-a", provider: "tavily", success: 3, fail: 2 },
  { scope: "key-a", provider: "exa", success: 5, fail: 1 },
  { scope: "key-b", provider: "tavily", success: 1, fail: 0 },
];
const minHour = "2026-09-01T00:00";

describe("readDistCallsByScopes", () => {
  it("聚合各 provider 的 success+fail，缺失 provider 补 0", async () => {
    const { db, count } = makeFakeDb(seedRows);
    const store = createUsageStore({ DB: db } as unknown as Env);
    const res = await store.readDistCallsByScopes(["key-a", "key-b"], minHour);
    expect(res["key-a"]).toEqual({ tavily: 5, exa: 6 });
    expect(res["key-b"]).toEqual({ tavily: 1, exa: 0 });
    expect(count()).toBe(1);
  });

  it("相同 scope 集合与 minHour 的第二次读取不新增 D1 聚合查询", async () => {
    const { db, count } = makeFakeDb(seedRows);
    const store = createUsageStore({ DB: db } as unknown as Env);
    await store.readDistCallsByScopes(["key-a", "key-b"], minHour);
    await store.readDistCallsByScopes(["key-a", "key-b"], minHour);
    expect(count()).toBe(1);
  });

  it("缓存命中期间 pending 增量叠加且不新增查询；upstream 不影响 dist 结果", async () => {
    const { db, count } = makeFakeDb(seedRows);
    const store = createUsageStore({ DB: db } as unknown as Env);
    await store.readDistCallsByScopes(["key-a", "key-b"], minHour); // 填充缓存
    const before = await store.readDistCallsByScopes(["key-a", "key-b"], minHour);
    expect(before["key-a"]).toEqual({ tavily: 5, exa: 6 });

    const h = hourKey();
    store.recordDistCall("key-a", "tavily", h, "success");
    store.recordUpstreamResult("up-1", "tavily", h, "success"); // 不应混入 dist

    const after = await store.readDistCallsByScopes(["key-a", "key-b"], minHour);
    expect(after["key-a"]).toEqual({ tavily: 6, exa: 6 }); // 仅 key-a.tavily +1
    expect(after["key-b"]).toEqual({ tavily: 1, exa: 0 });
    expect(count()).toBe(1); // 仍在缓存命中窗口，无新 D1 查询
  });

  it("空 scope 集合返回空 map 且不执行 D1 查询", async () => {
    const { db, count } = makeFakeDb(seedRows);
    const store = createUsageStore({ DB: db } as unknown as Env);
    const res = await store.readDistCallsByScopes([], minHour);
    expect(res).toEqual({});
    expect(count()).toBe(0);
  });

  it("修改 scope 集合或 minHour 会重新查询", async () => {
    const { db, count } = makeFakeDb(seedRows);
    const store = createUsageStore({ DB: db } as unknown as Env);
    await store.readDistCallsByScopes(["key-a", "key-b"], minHour);
    expect(count()).toBe(1);
    await store.readDistCallsByScopes(["key-a"], minHour);
    expect(count()).toBe(2);
    await store.readDistCallsByScopes(["key-a"], "2026-09-02T00:00");
    expect(count()).toBe(3);
  });
});
