// breaker 存储域测试：熔断状态属于 UpstreamKey 聚合，断言
// readBreakerState 映射、applyBreakerOutcome 的"cooldown + 计数"同批原子提交、
// consecutive=null 时只写 cooldown 不发计数 UPSERT。

import { describe, it, expect } from "vitest";
import type { Env } from "../src/types";
import { TAVILY } from "../src/providers";
import {
  readBreakerState,
  applyBreakerOutcome,
} from "../src/storage/upstream-keys";
import { makeScriptedD1 } from "./helpers/fake-d1";

const def = TAVILY.upstream;

describe("readBreakerState", () => {
  it("有行时按列映射", async () => {
    const { db, log } = makeScriptedD1([
      { results: [{ consecutive: 3, updated_at: 2000, created_at: 1500 }] },
    ]);
    const s = await readBreakerState({ DB: db } as unknown as Env, "k1");
    expect(s).toEqual({ consecutive: 3, updated_at: 2000, created_at: 1500 });
    expect(log()[0].op).toBe("first");
    expect(log()[0].binds).toEqual(["k1"]);
  });

  it("无行返回 null", async () => {
    const { db } = makeScriptedD1([{ results: [] }]);
    await expect(readBreakerState({ DB: db } as unknown as Env, "k9")).resolves.toBeNull();
  });
});

describe("applyBreakerOutcome 原子批次", () => {
  it("带计数：同批含 cooldown UPDATE + breaker UPSERT，绑定齐全", async () => {
    const { db, log } = makeScriptedD1([]);
    await applyBreakerOutcome({ DB: db } as unknown as Env, def, "k1", 5000, 4, 999, 888);
    const l = log();
    expect(l[0]).toMatchObject({ op: "batch" });
    expect(l).toHaveLength(3); // batch + 2 条 stmt
    expect(l[1].sql).toContain("UPDATE upstream_keys SET cooldown_until = ?1");
    expect(l[1].sql).toContain("WHERE provider = ?2 AND id = ?3");
    expect(l[1].binds).toEqual([5000, def.provider, "k1"]);
    expect(l[2].sql).toContain("INSERT INTO breaker_state");
    expect(l[2].sql).toContain("ON CONFLICT(id) DO UPDATE SET consecutive = excluded.consecutive");
    expect(l[2].binds).toEqual(["k1", 4, 999, 888]);
  });

  it("consecutive=null：只发 cooldown 一条（不碰计数）", async () => {
    const { db, log } = makeScriptedD1([]);
    await applyBreakerOutcome({ DB: db } as unknown as Env, def, "k1", 5000, null, 999);
    const l = log();
    expect(l).toHaveLength(2); // batch + 1 条 stmt
    expect(l[1].sql).toContain("UPDATE upstream_keys SET cooldown_until");
    expect(l.join(" ")).not.toContain("breaker_state");
  });
});
