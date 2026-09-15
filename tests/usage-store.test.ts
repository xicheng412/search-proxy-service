// 用量分发统计批量读取 + 30s 缓存 + pending 叠加的可执行验证。
// 使用 fake D1（prepare/all），不连接真实 Cloudflare 资源。

import { describe, it, expect } from "vitest";
import { createUsageStore } from "../src/usage";
import { hourKey } from "../src/domain";
import type { Env } from "../src/types";
import { makeConstantD1, makeScriptedD1 } from "./helpers/fake-d1";

const seedRows = [
  { scope: "key-a", provider: "tavily", success: 3, fail: 2 },
  { scope: "key-a", provider: "exa", success: 5, fail: 1 },
  { scope: "key-b", provider: "tavily", success: 1, fail: 0 },
];
const minHour = "2026-09-01T00:00";

describe("readDistCallsByScopes", () => {
  it("跨全部 provider 汇总 success/fail，缺失 provider 不产生计数", async () => {
    const { db, allCalls } = makeConstantD1(seedRows);
    const store = createUsageStore({ DB: db } as unknown as Env);
    const res = await store.readDistCallsByScopes(["key-a", "key-b"], minHour);
    expect(res["key-a"]).toEqual({ success: 8, fail: 3 }); // tavily 3/2 + exa 5/1
    expect(res["key-b"]).toEqual({ success: 1, fail: 0 });
    expect(allCalls()).toBe(1);
  });

  it("相同 scope 集合与 minHour 的第二次读取不新增 D1 聚合查询", async () => {
    const { db, allCalls } = makeConstantD1(seedRows);
    const store = createUsageStore({ DB: db } as unknown as Env);
    await store.readDistCallsByScopes(["key-a", "key-b"], minHour);
    await store.readDistCallsByScopes(["key-a", "key-b"], minHour);
    expect(allCalls()).toBe(1);
  });

  it("缓存命中期间 pending 增量叠加且不新增查询；upstream 不影响 dist 结果", async () => {
    const { db, allCalls } = makeConstantD1(seedRows);
    const store = createUsageStore({ DB: db } as unknown as Env);
    await store.readDistCallsByScopes(["key-a", "key-b"], minHour); // 填充缓存
    const before = await store.readDistCallsByScopes(["key-a", "key-b"], minHour);
    expect(before["key-a"]).toEqual({ success: 8, fail: 3 });

    const h = hourKey();
    store.recordDistCall("key-a", h, "success"); // 新签名：无 provider 实参
    store.recordUpstreamResult("up-1", "tavily", h, "success"); // 不应混入 dist

    const after = await store.readDistCallsByScopes(["key-a", "key-b"], minHour);
    expect(after["key-a"]).toEqual({ success: 9, fail: 3 }); // 仅 key-a 的 dist +1
    expect(after["key-b"]).toEqual({ success: 1, fail: 0 });
    expect(allCalls()).toBe(1); // 仍在缓存命中窗口，无新 D1 查询
  });

  it("空 scope 集合返回空 map 且不执行 D1 查询", async () => {
    const { db, allCalls } = makeConstantD1(seedRows);
    const store = createUsageStore({ DB: db } as unknown as Env);
    const res = await store.readDistCallsByScopes([], minHour);
    expect(res).toEqual({});
    expect(allCalls()).toBe(0);
  });

  it("修改 scope 集合或 minHour 会重新查询", async () => {
    const { db, allCalls } = makeConstantD1(seedRows);
    const store = createUsageStore({ DB: db } as unknown as Env);
    await store.readDistCallsByScopes(["key-a", "key-b"], minHour);
    expect(allCalls()).toBe(1);
    await store.readDistCallsByScopes(["key-a"], minHour);
    expect(allCalls()).toBe(2);
    await store.readDistCallsByScopes(["key-a"], "2026-09-02T00:00");
    expect(allCalls()).toBe(3);
  });
});

describe("readUpstreamWeightSignal", () => {
  it("信号读不发 D1（空 base、无 pending）", async () => {
    const { db, allCalls } = makeConstantD1([]);
    const store = createUsageStore({ DB: db } as unknown as Env);
    await expect(store.readUpstreamWeightSignal(["key-a"])).resolves.toEqual({ "key-a": 0 });
    expect(allCalls()).toBe(0);
  });

  it("pending 叠加且不新增 D1", async () => {
    const { db, allCalls } = makeConstantD1([]);
    const store = createUsageStore({ DB: db } as unknown as Env);
    store.recordUpstreamResult("key-a", "tavily", hourKey(), "fail");
    await expect(store.readUpstreamWeightSignal(["key-a"])).resolves.toEqual({ "key-a": 1 });
    expect(allCalls()).toBe(0);
  });

  it("flush 刷新 base 并合并；重复信号读不再查 D1", async () => {
    const signalRows = [{ scope: "key-a", provider: "tavily", success: 3, fail: 2 }];
    const { db, allCalls } = makeConstantD1(signalRows);
    const store = createUsageStore({ DB: db } as unknown as Env);
    store.recordUpstreamResult("key-a", "tavily", hourKey(), "success"); // 让 flush 有东西可写
    let captured: Promise<unknown> | undefined;
    store.flushSoon({ waitUntil: (p) => (captured = p) } as never);
    expect(captured).toBeDefined();
    await captured;
    await expect(store.readUpstreamWeightSignal(["key-a", "key-b"])).resolves.toEqual({
      "key-a": 2, // 仅来自 base 快照（pending 已被 flush 清空）
      "key-b": 0,
    });
    expect(allCalls()).toBe(1); // 只有 flush 内刷新一次
    await expect(store.readUpstreamWeightSignal(["key-a"])).resolves.toEqual({ "key-a": 2 });
    expect(allCalls()).toBe(1); // 第二次信号读不加 D1
  });

  it("flush 刷新信号 base 时按 weightWindowMs 滑动窗口取数（非当日）", async () => {
    const { db, log } = makeScriptedD1([{ results: [] }, { results: [] }]);
    const store = createUsageStore({ DB: db } as unknown as Env, { weightWindowMs: 5 * 60_000 });
    store.recordUpstreamResult("key-a", "tavily", hourKey(), "fail"); // 让 flush 有内容
    let captured: Promise<unknown> | undefined;
    store.flushSoon({ waitUntil: (p) => (captured = p) } as never);
    expect(captured).toBeDefined();
    await captured;
    // flush：batch（mergeUsage）→ all（信号刷新）；刷新 SQL 的下界绑定为窗口起点。
    const refresh = log().filter((c) => c.op === "all" && c.sql.includes("hour >= ?2"));
    expect(refresh).toHaveLength(1);
    expect(refresh[0].binds[1]).toBe(hourKey(Date.now() - 5 * 60_000));
  });

  it("默认 weightWindowMs（30min）下刷新下界随之变化", async () => {
    const { db, log } = makeScriptedD1([{ results: [] }, { results: [] }]);
    const store = createUsageStore({ DB: db } as unknown as Env);
    store.recordUpstreamResult("key-a", "tavily", hourKey(), "fail");
    let captured: Promise<unknown> | undefined;
    store.flushSoon({ waitUntil: (p) => (captured = p) } as never);
    expect(captured).toBeDefined();
    await captured;
    const refresh = log().filter((c) => c.op === "all" && c.sql.includes("hour >= ?2"));
    expect(refresh).toHaveLength(1);
    expect(refresh[0].binds[1]).toBe(hourKey(Date.now() - 30 * 60_000));
  });
});

describe("flush 双阈值 + flushNow", () => {
  it("flushMaxPending 条数阈值：年龄未到但条数达上限即落库", async () => {
    const { db, batchCalls } = makeConstantD1([]);
    const store = createUsageStore({ DB: db } as unknown as Env, {
      flushIntervalMs: 60_000,
      flushMaxPending: 2,
    });
    const h = hourKey();
    // 首次 flushSoon 落库并推进 lastFlushAt（此后 60s 内年龄分支不再满足）
    store.recordUpstreamResult("key-a", "tavily", h, "fail");
    let first: Promise<unknown> | undefined;
    store.flushSoon({ waitUntil: (p) => (first = p) } as never);
    expect(first).toBeDefined();
    await first;
    expect(batchCalls()).toBe(1);
    // 年龄未到（距上次 <60s），pending 条目达 2 ≥ flushMaxPending → 条数兜底触发落库
    // （同一小时桶的多条 record 合并为一条 pending 条目，故用两个 scope 制造两条）
    store.recordUpstreamResult("key-a", "tavily", h, "fail");
    store.recordUpstreamResult("key-b", "tavily", h, "fail");
    let second: Promise<unknown> | undefined;
    store.flushSoon({ waitUntil: (p) => (second = p) } as never);
    expect(second).toBeDefined();
    await second;
    expect(batchCalls()).toBe(2);
  });

  it("flushNow 立即落库缓冲并清空 pending；随后信号走 base", async () => {
    const signalRows = [{ scope: "key-a", provider: "tavily", success: 0, fail: 3 }];
    const { db, batchCalls } = makeConstantD1(signalRows);
    const store = createUsageStore({ DB: db } as unknown as Env);
    const h = hourKey();
    store.recordUpstreamResult("key-a", "tavily", h, "success");
    store.recordUpstreamResult("key-a", "tavily", h, "fail");
    await store.flushNow();
    expect(batchCalls()).toBe(1); // mergeUsage → DB.batch 一次
    // pending 已清空：信号只来自 flush 内刷新的 base（D1 fail=3）
    await expect(store.readUpstreamWeightSignal(["key-a"])).resolves.toEqual({ "key-a": 3 });
  });
});

describe("权重信号窗口过滤 + 独立刷新", () => {
  it("pending 中窗口外小时桶的 fail 不计入权重", async () => {
    const { db, allCalls } = makeConstantD1([]);
    const store = createUsageStore({ DB: db } as unknown as Env, { weightWindowMs: 60 * 60_000 });
    // 越窗桶：比 minHour 早至少一小时，保证落在滑动窗口外
    const stale = hourKey(Date.now() - 121 * 60_000);
    const now = hourKey();
    store.recordUpstreamResult("key-a", "tavily", stale, "fail");
    store.recordUpstreamResult("key-a", "tavily", now, "fail");
    await expect(store.readUpstreamWeightSignal(["key-a"])).resolves.toEqual({ "key-a": 1 });
    expect(allCalls()).toBe(0); // 纯 pending 叠加，无 D1 往返
  });

  it("refreshWeightBase 独立刷新权重 base；120s 内重复调用不新增 D1", async () => {
    const { db, log } = makeScriptedD1([{ results: [] }]);
    const store = createUsageStore({ DB: db } as unknown as Env, {
      flushIntervalMs: 30 * 60 * 1000,
    });
    store.recordUpstreamResult("key-a", "tavily", hourKey(), "fail"); // 缓冲非空，验证与 flush 解耦
    await store.refreshWeightBase();
    const refresh = () => log().filter((c) => c.op === "all" && c.sql.includes("hour >= ?2"));
    expect(refresh()).toHaveLength(1);
    expect(refresh()[0].binds[1]).toBe(hourKey(Date.now() - 30 * 60_000));
    await store.refreshWeightBase();
    expect(refresh()).toHaveLength(1); // 120s TTL 内第二次 no-op（0 D1）
    // refreshWeightBase 不触 flush：缓冲仍在 pending，未产生 INSERT
    expect(log().some((c) => c.op === "batch")).toBe(false);
  });
});

describe("readUpstreamSeries", () => {
  const upstreamRows = [
    { hour: "2026-09-01T08:00", provider: "tavily", success: 3, fail: 1 },
    { hour: "2026-09-01T08:00", provider: "exa", success: 2, fail: 0 },
    { hour: "2026-09-01T09:00", provider: "tavily", success: 1, fail: 0 },
  ];
  const seriesMinHour = "2026-09-01T00:00";

  it("按小时升序聚合各 provider 的 success+fail，缺失 provider 补 0", async () => {
    const { db, allCalls } = makeConstantD1(upstreamRows);
    const store = createUsageStore({ DB: db } as unknown as Env);
    const res = await store.readUpstreamSeries(seriesMinHour);
    expect(res).toEqual([
      { hour: "2026-09-01T08:00", tavily: 4, exa: 2 },
      { hour: "2026-09-01T09:00", tavily: 1, exa: 0 },
    ]);
    expect(allCalls()).toBe(1);
  });

  it("相同 minHour 的第二次读取不新增 D1 查询", async () => {
    const { db, allCalls } = makeConstantD1(upstreamRows);
    const store = createUsageStore({ DB: db } as unknown as Env);
    await store.readUpstreamSeries(seriesMinHour);
    const res = await store.readUpstreamSeries(seriesMinHour);
    expect(res).toHaveLength(2);
    expect(allCalls()).toBe(1);
  });

  it("pending 叠加且不新增 D1 查询；小时桶不在 base 时兜底创建；dist 不混入 upstream", async () => {
    const { db, allCalls } = makeConstantD1(upstreamRows);
    const store = createUsageStore({ DB: db } as unknown as Env);
    await store.readUpstreamSeries(seriesMinHour); // 填缓存
    const h = "2026-09-01T10:00";
    store.recordUpstreamResult("up-9", "tavily", h, "success");
    store.recordUpstreamResult("up-9", "tavily", h, "fail");
    store.recordUpstreamResult("up-9", "exa", h, "success");
    store.recordDistCall("key-x", h, "success"); // 不应混入 upstream

    const res = await store.readUpstreamSeries(seriesMinHour);
    expect(res).toEqual([
      { hour: "2026-09-01T08:00", tavily: 4, exa: 2 },
      { hour: "2026-09-01T09:00", tavily: 1, exa: 0 },
      { hour: "2026-09-01T10:00", tavily: 2, exa: 1 },
    ]);
    expect(allCalls()).toBe(1); // 仍在 TTL 窗口内，无新 D1 查询
  });

  it("seriesTtlMs=0 时每次读取都重新查询 D1", async () => {
    const { db, allCalls } = makeConstantD1([]);
    const store = createUsageStore({ DB: db } as unknown as Env, { seriesTtlMs: 0 });
    await store.readUpstreamSeries(seriesMinHour);
    await store.readUpstreamSeries(seriesMinHour);
    expect(allCalls()).toBe(2);
  });

  it("不同 minHour 触发重新查询", async () => {
    const { db, allCalls } = makeConstantD1(upstreamRows);
    const store = createUsageStore({ DB: db } as unknown as Env);
    await store.readUpstreamSeries(seriesMinHour);
    const res = await store.readUpstreamSeries("2026-09-02T00:00");
    expect(res).toHaveLength(2);
    expect(allCalls()).toBe(2);
  });
});

describe("readDistSeries", () => {
  // dist 行 provider 恒 NULL（0004 起无 provider 维度）：calls 须为该小时全部行 success+fail 合计。
  const distRows = [
    { hour: "2026-09-01T08:00", provider: null, success: 3, fail: 1 },
    { hour: "2026-09-01T08:00", provider: null, success: 2, fail: 0 },
    { hour: "2026-09-01T08:00", provider: null, success: 1, fail: 0 },
    { hour: "2026-09-01T09:00", provider: null, success: 1, fail: 0 },
  ];
  const seriesMinHour = "2026-09-01T00:00";

  it("按小时升序聚合，calls 为跨全部 provider 的 success+fail 合计", async () => {
    const { db, allCalls } = makeConstantD1(distRows);
    const store = createUsageStore({ DB: db } as unknown as Env);
    const res = await store.readDistSeries(seriesMinHour);
    expect(res).toEqual([
      { hour: "2026-09-01T08:00", calls: 7 }, // (3+1)+(2+0)+(1+0)
      { hour: "2026-09-01T09:00", calls: 1 },
    ]);
    expect(allCalls()).toBe(1);
  });

  it("相同 minHour 的第二次读取不新增 D1 查询", async () => {
    const { db, allCalls } = makeConstantD1(distRows);
    const store = createUsageStore({ DB: db } as unknown as Env);
    await store.readDistSeries(seriesMinHour);
    const res = await store.readDistSeries(seriesMinHour);
    expect(res).toHaveLength(2);
    expect(allCalls()).toBe(1);
  });

  it("pending 叠加且不新增 D1 查询；小时桶不在 base 时兜底创建；upstream 不混入 dist", async () => {
    const { db, allCalls } = makeConstantD1(distRows);
    const store = createUsageStore({ DB: db } as unknown as Env);
    await store.readDistSeries(seriesMinHour); // 填缓存
    const h = "2026-09-01T10:00";
    store.recordDistCall("key-x", h, "success");
    store.recordDistCall("key-x", h, "success");
    store.recordDistCall("key-x", h, "fail");
    store.recordUpstreamResult("up-9", "tavily", h, "success"); // 不应混入 dist

    const res = await store.readDistSeries(seriesMinHour);
    expect(res).toEqual([
      { hour: "2026-09-01T08:00", calls: 7 },
      { hour: "2026-09-01T09:00", calls: 1 },
      { hour: "2026-09-01T10:00", calls: 3 },
    ]);
    expect(allCalls()).toBe(1); // 仍在 TTL 窗口内，无新 D1 查询
  });

  it("seriesTtlMs=0 时每次读取都重新查询 D1", async () => {
    const { db, allCalls } = makeConstantD1([]);
    const store = createUsageStore({ DB: db } as unknown as Env, { seriesTtlMs: 0 });
    await store.readDistSeries(seriesMinHour);
    await store.readDistSeries(seriesMinHour);
    expect(allCalls()).toBe(2);
  });

  it("不同 minHour 触发重新查询", async () => {
    const { db, allCalls } = makeConstantD1(distRows);
    const store = createUsageStore({ DB: db } as unknown as Env);
    await store.readDistSeries(seriesMinHour);
    const res = await store.readDistSeries("2026-09-02T00:00");
    expect(res).toHaveLength(2);
    expect(allCalls()).toBe(2);
  });
});
