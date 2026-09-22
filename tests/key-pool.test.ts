// KeyPool 内存池单测：冷却/熔断权威态的原地生效、checkpoint 批量 SQL 与 dirty 生命周期、
// reload 合并（保留内存冷却、采纳 admin 的 name/status、清理已删 id）、失败保留 dirty。
// 读论断一律走 pool 公开接口，不 assert 内部闭包结构。

import { describe, it, expect } from "vitest";
import type { Env } from "../src/types";
import { TAVILY } from "../src/providers";
import type { CoreKey } from "../src/domain";
import { createKeyPool } from "../src/key-pool";
import { makeScriptedD1 } from "./helpers/fake-d1";

const def = TAVILY.upstream;

function key(id: string, overrides: Partial<CoreKey> = {}): CoreKey {
  return {
    id,
    key: "tvly-" + id,
    name: "",
    status: "enabled",
    cooldown_until: null,
    suspended_cause: null,
    created_at: Date.now(),
    ...overrides,
  };
}

describe("KeyPool", () => {
  it("1. applyBreakerOutcome 原地生效：getKeys() 同一对象、cooldown 即刻可见、breaker 记录", () => {
    const pool = createKeyPool({ DB: {} } as unknown as Env, def, [key("k1")]);
    const snapshot = pool.getKeys()[0];
    pool.applyBreakerOutcome("k1", 5000, "breaker", 2, 1000);
    expect(pool.getKeys()[0]).toBe(snapshot); // 同一对象引用
    expect(snapshot.cooldown_until).toBe(5000); // 原地改，选 key 可见
    expect(snapshot.suspended_cause).toBe("breaker");
    expect(pool.getBreakerState("k1")).toEqual({ consecutive: 2, updated_at: 1000, created_at: 1000 });
  });

  it("2. consecutive===null 不生成 getBreakerState 条目", () => {
    const pool = createKeyPool({ DB: {} } as unknown as Env, def, [key("k1")]);
    pool.applyBreakerOutcome("k1", 5000, "post-use", null, 1000);
    expect(pool.getBreakerState("k1")).toBeNull();
  });

  it("3. flushNow 批量 checkpoint：一次 DB.batch 写 cooldown_until，dirty 清零后不再写", async () => {
    const { db, log } = makeScriptedD1([]);
    const pool = createKeyPool({ DB: db } as unknown as Env, def, [key("k1"), key("k2")]);
    pool.applyBreakerOutcome("k1", 5000, "breaker", 0, 1000);
    pool.applyBreakerOutcome("k2", 6000, "breaker", 1, 1000);
    await pool.flushNow();
    const l = log();
    expect(l[0].op).toBe("batch");
    expect(l).toHaveLength(3); // batch + 2 条 stmt
    expect(l[1].sql).toContain("UPDATE upstream_keys SET cooldown_until = ?1, suspended_cause = ?2");
    expect(l[1].sql).toContain("WHERE provider = ?3 AND id = ?4");
    expect(l[1].binds).toEqual([5000, "breaker", def.provider, "k1"]);
    expect(l[2].binds).toEqual([6000, "breaker", def.provider, "k2"]);
    // dirty 已清零：再 flushNow 不新增任何 D1 调用
    const count = log().length;
    await pool.flushNow();
    expect(log().length).toBe(count);
  });

  it("4. reload 合并：保留内存 cooldown、采纳 admin 的 name/status、清理已删 id 及其计数", async () => {
    const { db } = makeScriptedD1([
      {
        results: [
          { id: "k1", key: "tvly-k1", name: "renamed", status: "disabled", cooldown_until: null, suspended_cause: null, created_at: 1 },
          { id: "k3", key: "tvly-k3", name: "", status: "enabled", cooldown_until: 999, suspended_cause: "post-use", created_at: 2 },
        ],
      },
    ]);
    const pool = createKeyPool({ DB: db } as unknown as Env, def, [
      key("k1", { cooldown_until: 5000, suspended_cause: "breaker" }),
      key("k2"),
    ]);
    pool.applyBreakerOutcome("k2", 7000, "breaker", 1, 1000); // 将随 k2 删除一并清理
    await pool.reload();
    expect(pool.getKeys().map((k) => k.id)).toEqual(["k1", "k3"]);
    const k1 = pool.getKeys()[0];
    expect(k1.cooldown_until).toBe(5000); // 内存冷却永远优先（DB 为 null 不覆盖）
    expect(k1.suspended_cause).toBe("breaker"); // 内存 cause 同样优先
    expect(k1.name).toBe("renamed"); // 采纳 admin 改名
    expect(k1.status).toBe("disabled"); // 采纳 admin 停用
    const k3 = pool.getKeys()[1];
    expect(k3.cooldown_until).toBe(999); // 新对象取自 D1
    expect(k3.suspended_cause).toBe("post-use"); // 新对象 cause 取自 D1
    expect(pool.getBreakerState("k2")).toBeNull(); // 已删 key 的计数清理
  });

  it("5. checkpoint 写失败静默保留 dirty，恢复后补写", async () => {
    const holder = {
      DB: {
        prepare() {
          return {
            bind() {
              return { run: async () => {}, all: async () => ({ results: [] }), first: async () => null };
            },
          };
        },
        async batch() {
          throw new Error("db down");
        },
        db: "broken",
      },
    } as unknown as Env;
    const pool = createKeyPool(holder, def, [key("k1")]);
    pool.applyBreakerOutcome("k1", 5000, "breaker", 0, 1000);
    await expect(pool.flushNow()).resolves.toBeUndefined(); // 失败不抛
    // dirty 保留：切回可用 DB 后同一批补写成功
    const { db: newDb, log } = makeScriptedD1([]);
    (holder as { DB: unknown }).DB = newDb;
    await pool.flushNow();
    const l = log();
    expect(l[0].op).toBe("batch");
    expect(l[1].binds).toEqual([5000, "breaker", def.provider, "k1"]);
  });

  it("6. maybeCheckpoint：dirty 达阈值触发；未达且刚 checkpoint 不产生 D1 调用", async () => {
    const { db, log } = makeScriptedD1([]);
    const env = { DB: db } as unknown as Env;
    const pool = createKeyPool(env, def, Array.from({ length: 16 }, (_, i) => key("k" + i)));
    for (let i = 0; i < 16; i++) pool.applyBreakerOutcome("k" + i, i + 1, "breaker", 0, i);
    await pool.maybeCheckpoint();
    expect(log().filter((c) => c.op === "batch")).toHaveLength(1); // 阈值触发一次落库
    // 刚 checkpoint 后少量新增 dirty：未达阈值且未过间隔 → 0 D1
    pool.applyBreakerOutcome("k0", 1, "breaker", 0, 100);
    await pool.maybeCheckpoint();
    expect(log().filter((c) => c.op === "batch")).toHaveLength(1); // 无新增
  });

  it("7. activate 清掉机器冷却（cooldown + cause），该 key 立即可选", () => {
    const pool = createKeyPool({ DB: {} } as unknown as Env, def, [key("k1")]);
    pool.applyBreakerOutcome("k1", 5000, "breaker", 2, 1000);
    expect(pool.getKeys()[0].cooldown_until).toBe(5000);
    expect(pool.getKeys()[0].suspended_cause).toBe("breaker");
    pool.activate("k1");
    expect(pool.getKeys()[0].cooldown_until).toBeNull();
    expect(pool.getKeys()[0].suspended_cause).toBeNull();
  });
});
