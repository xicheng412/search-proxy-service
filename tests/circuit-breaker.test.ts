// 熔断/冷却数学单测：经 KeyPool 内存池断言 recordUpstream* 的指数退避、10min 空窗复位
// 与三层冷却语义。默认配置（postUse 10s / base 600s / invalid 43200s）由 fakeKV.get→null 稳定给出。
// 断言一律读 pool.getKeys()[].cooldown_until / pool.getBreakerState(id)，不 assert 内部实现。

import { describe, it, expect } from "vitest";
import type { Env } from "../src/types";
import { TAVILY } from "../src/providers";
import { createKeyPool, type KeyPool } from "../src/key-pool";
import {
  recordUpstreamSuccess,
  recordUpstreamFailure,
  recordUpstreamRateLimit,
  recordUpstreamInvalid,
} from "../src/circuit-breaker";

const fakeKV = { get: async () => null }; // 无配置 → 默认：postUse 10s / base 600s / invalid 43200s
const def = TAVILY.upstream;

// 基准时刻不必贴近真实时间：全部是相对 now 的时长断言。
const T0 = 1_000_000;
const POST_USE_MS = 10_000;
const BASE_MS = 600_000;

function fresh(): { env: Env; pool: KeyPool } {
  const env = { KV: fakeKV } as unknown as Env;
  const pool = createKeyPool(env, def, [
    { id: "k1", key: "tvly-k1", name: "", status: "enabled", cooldown_until: null, created_at: T0 },
  ]);
  return { env, pool };
}

function cool(pool: KeyPool): number | null {
  return pool.getKeys()[0].cooldown_until;
}

describe("recordUpstreamFailure 指数退避", () => {
  it("首次失败：consecutive=1，冷却 = now + max(post-use, base×2^1)", async () => {
    const { env, pool } = fresh();
    await recordUpstreamFailure(env, pool, "k1", T0);
    expect(pool.getBreakerState("k1")).toEqual({ consecutive: 1, updated_at: T0, created_at: T0 });
    expect(cool(pool)).toBe(T0 + Math.max(POST_USE_MS, BASE_MS * 2)); // + 1_200_000
  });

  it("窗口内二次失败：consecutive=2，冷却 = now + max(post-use, base×2^2)", async () => {
    const { env, pool } = fresh();
    await recordUpstreamFailure(env, pool, "k1", T0);
    await recordUpstreamFailure(env, pool, "k1", T0 + POST_USE_MS);
    expect(pool.getBreakerState("k1")!.consecutive).toBe(2);
    expect(cool(pool)).toBe(T0 + POST_USE_MS + Math.max(POST_USE_MS, BASE_MS * 4)); // + 2_400_000
  });

  it("超窗失败（距上次 > BREAKER_TTL_MS 10min）：计数复位为 1", async () => {
    const { env, pool } = fresh();
    await recordUpstreamFailure(env, pool, "k1", T0);
    await recordUpstreamFailure(env, pool, "k1", T0 + POST_USE_MS); // updated_at 推进到 T0+10_000
    // 距 updated_at 已超 10min 空窗（> T0+10_000+600_000）→ 视为恢复，从 1 重计
    const beyond = T0 + POST_USE_MS + BASE_MS + 90_000;
    await recordUpstreamFailure(env, pool, "k1", beyond);
    expect(pool.getBreakerState("k1")!.consecutive).toBe(1);
    expect(cool(pool)).toBe(beyond + Math.max(POST_USE_MS, BASE_MS * 2));
  });
});

describe("recordUpstreamSuccess", () => {
  it("归零计数，冷却回缩为 post-use", async () => {
    const { env, pool } = fresh();
    pool.applyBreakerOutcome("k1", 9_999_999, 2, T0); // 预置连续失败 2 次
    await recordUpstreamSuccess(env, pool, "k1", T0 + 5_000);
    expect(pool.getBreakerState("k1")).toEqual({ consecutive: 0, updated_at: T0 + 5_000, created_at: T0 });
    expect(cool(pool)).toBe(T0 + 5_000 + POST_USE_MS);
  });
});

describe("recordUpstreamRateLimit", () => {
  it("仅 post-use 冷却，不碰连续失败计数", async () => {
    const { env, pool } = fresh();
    pool.applyBreakerOutcome("k1", 0, 3, T0); // 预置连续失败 3 次
    await recordUpstreamRateLimit(env, pool, "k1", T0 + 1_000);
    expect(cool(pool)).toBe(T0 + 1_000 + POST_USE_MS);
    expect(pool.getBreakerState("k1")).toEqual({ consecutive: 3, updated_at: T0, created_at: T0 });
  });
});

describe("recordUpstreamInvalid", () => {
  it("固定长冷却（默认 12h，以 post-use 为地板），不碰连续失败计数", async () => {
    const { env, pool } = fresh();
    pool.applyBreakerOutcome("k1", 0, 3, T0); // 预置连续失败 3 次
    await recordUpstreamInvalid(env, pool, "k1", T0 + 1_000);
    expect(cool(pool)).toBe(T0 + 1_000 + 43_200_000); // 12h = 43_200s * 1000
    expect(pool.getBreakerState("k1")).toEqual({ consecutive: 3, updated_at: T0, created_at: T0 });
  });
});
