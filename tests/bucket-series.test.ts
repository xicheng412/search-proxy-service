// readDistSummaries 三段区间边界 + sumDistInRange 半开区间聚合的可执行验证。

import { describe, it, expect, vi, afterEach } from "vitest";
import { createUsageStore } from "../src/usage";
import { sumDistInRange, type DistSeriesPoint } from "../src/usage/reads/series";
import type { Env } from "../src/types";
import { makeConstantD1 } from "./helpers/fake-d1";

describe("sumDistInRange", () => {
  it("[fromMs, toMs) 半开区间按桶起算时刻归属；NaN 桶键跳过", () => {
    const points: DistSeriesPoint[] = [
      { bucket: "2026-09-01T10:00", calls: 5 },
      { bucket: "2026-09-01T10:15", calls: 2 },
      { bucket: "not-a-date", calls: 7 }, // Date.parse → NaN → 跳过
    ];
    const from = Date.parse("2026-09-01T10:00Z");
    expect(sumDistInRange(points, from, Date.parse("2026-09-01T10:30Z"))).toBe(7); // 5 + 2，NaN 不计
    // 恰落在 toMs 的桶不进区间
    expect(
      sumDistInRange([{ bucket: "2026-09-01T10:30", calls: 3 }], from, Date.parse("2026-09-01T10:30Z"))
    ).toBe(0);
    // 仅 NaN 桶 → 0
    expect(sumDistInRange([{ bucket: "bad", calls: 1 }], 0, Number.MAX_SAFE_INTEGER)).toBe(0);
  });
});

describe("readDistSummaries", () => {
  afterEach(() => vi.useRealTimers());

  it("三段区间边界：当前桶 / 24h 前边界 / 昨日末桶 / 今日 00:00 各自计入或排除", async () => {
    // 固定 now=2026-09-01T11:00Z：
    //   当前桶 09-01T11:00（last24h+今日，非昨日）
    //   24h 前边界桶 08-31T11:00（last24h+昨日，非今日）
    //   昨日末桶 08-31T23:45（仅昨日）
    //   今日 00:00 09-01T00:00（last24h+今日，非昨日）
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date("2026-09-01T11:00:00Z"));

    const distRows = [
      { bucket: "2026-09-01T11:00", provider: null, success: 1, fail: 0 },
      { bucket: "2026-08-31T11:00", provider: null, success: 5, fail: 0 },
      { bucket: "2026-08-31T23:45", provider: null, success: 7, fail: 0 },
      { bucket: "2026-09-01T00:00", provider: null, success: 3, fail: 0 },
    ];
    const { db } = makeConstantD1(distRows);
    const store = createUsageStore({ DB: db } as unknown as Env);
    const s = await store.readDistSummaries("2026-08-26T00:00");
    // last24h：24h 前边界(5) + 昨日末桶(7) + 今日00:00(3) + 当前桶(1) = 16
    // today：今日00:00(3) + 当前桶(1) = 4；yesterday：昨日末桶(7) + 24h前边界(5) = 12
    expect(s).toEqual({ last24h: 16, today: 4, yesterday: 12 });
  });
});
