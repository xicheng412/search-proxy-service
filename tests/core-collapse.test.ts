// collapsePending 单遍聚合原语的可执行验证。
// 直接构造 core（collapsePending 与 record* 不触 env），灌数据后断言过滤/累加/归一语义。

import { describe, it, expect } from "vitest";
import { createCore, type UsageCore } from "../src/usage/core";
import type { Env } from "../src/types";

interface Accum {
  scope: string;
  provider: string | null;
  hour: string;
  success: number;
  fail: number;
}

/** 收集 collapsePending 的 acc 回调，按 scope 展开为断言友好的数组。 */
function collect(
  core: UsageCore,
  kind: Parameters<UsageCore["collapsePending"]>[0],
  scopes: ReadonlySet<string>,
  minHour: string | null
): Accum[] {
  const out: Accum[] = [];
  core.collapsePending(kind, scopes, minHour, (scope, provider, hour, success, fail) => {
    out.push({ scope, provider, hour, success, fail });
  });
  return out;
}

function makeCore() {
  // createCore 仅在 flush/mergeUsage 用到 env；record* 与 collapsePending 不触 env，故传空。
  return createCore({} as unknown as Env);
}

describe("core.collapsePending", () => {
  it("kind 过滤：混入 dist 与 upstream 条目，只累加目标 kind", () => {
    const core = makeCore();
    core.recordUpstreamResult("key-a", "tavily", "2026-09-01T08:00", "success");
    core.recordUpstreamResult("key-b", "exa", "2026-09-01T09:00", "fail");
    core.recordDistCall("dist-1", "2026-09-01T08:00");

    const up = collect(core, "upstream", new Set(), null);
    const dist = collect(core, "dist", new Set(), null);

    expect(up).toEqual([
      { scope: "key-a", provider: "tavily", hour: "2026-09-01T08:00", success: 1, fail: 0 },
      { scope: "key-b", provider: "exa", hour: "2026-09-01T09:00", success: 0, fail: 1 },
    ]);
    expect(dist).toEqual([
      { scope: "dist-1", provider: null, hour: "2026-09-01T08:00", success: 1, fail: 0 },
    ]);
  });

  it("scopes 过滤：非目标 scope 不计；空集命中全部", () => {
    const core = makeCore();
    core.recordUpstreamResult("key-a", "tavily", "2026-09-01T08:00", "success");
    core.recordUpstreamResult("key-a", "tavily", "2026-09-01T09:00", "fail");
    core.recordUpstreamResult("key-b", "tavily", "2026-09-01T08:00", "fail");

    const onlyA = collect(core, "upstream", new Set(["key-a"]), null);
    expect(onlyA).toHaveLength(2);
    expect(onlyA.filter((e) => e.scope === "key-a").length).toBe(2);
    expect(onlyA.some((e) => e.scope === "key-b")).toBe(false);

    const all = collect(core, "upstream", new Set(), null);
    expect(all).toHaveLength(3);
    // 键序：同 scope 同 provider 同小时桶在 pending 中合并为一条；三条 record 键各不相同。
    const byScope = new Map<string, { success: number; fail: number }>();
    for (const e of all) {
      const cur = byScope.get(e.scope) ?? { success: 0, fail: 0 };
      cur.success += e.success;
      cur.fail += e.fail;
      byScope.set(e.scope, cur);
    }
    expect(byScope.get("key-a")).toEqual({ success: 1, fail: 1 });
    expect(byScope.get("key-b")).toEqual({ success: 0, fail: 1 });
  });

  it("minHour 过滤：截断旧小时桶；null 累加全部小时", () => {
    const core = makeCore();
    core.recordUpstreamResult("key-a", "tavily", "2026-09-01T07:00", "fail");
    core.recordUpstreamResult("key-a", "tavily", "2026-09-01T08:00", "fail");
    core.recordUpstreamResult("key-a", "tavily", "2026-09-01T09:00", "fail");

    const from8 = collect(core, "upstream", new Set(["key-a"]), "2026-09-01T08:00");
    expect(from8).toHaveLength(2); // 只剩 08:00、09:00
    expect(from8.map((e) => e.hour)).toEqual(["2026-09-01T08:00", "2026-09-01T09:00"]);

    const all = collect(core, "upstream", new Set(["key-a"]), null);
    expect(all).toHaveLength(3);
    expect(all.reduce((n, e) => n + e.fail, 0)).toBe(3);
  });

  it("provider 归一：dist 条目（无 provider 维度）经 acc 收到 provider === null", () => {
    const core = makeCore();
    core.recordDistCall("dist-1", "2026-09-01T08:00");
    core.recordUpstreamResult("key-a", "tavily", "2026-09-01T08:00", "success");

    const dist = collect(core, "dist", new Set(["dist-1"]), null);
    expect(dist).toHaveLength(1);
    expect(dist[0].provider).toBeNull();

    const up = collect(core, "upstream", new Set(["key-a"]), null);
    expect(up[0].provider).toBe("tavily");
  });
});
