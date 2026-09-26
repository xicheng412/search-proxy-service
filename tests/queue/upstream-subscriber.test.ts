// upstream-subscriber 单测：一次 UpstreamAttemptSettled 被订阅者消费——冷却 + usage 各记
// 一次；rate-limit 记失败 + 疑似失效长冷却；client-error 不处理（不入事件）。回归保护：
// DO 重建叠加订阅者导致的 usage/冷却翻倍（见 upstream-subscriber.ts 头注释）。
// 订阅者返回冷却 promise（总线忽略），直接 await 即可确定性等待异步 KV 配置读取后落池，
// 无需真实定时器。

import { describe, it, expect } from "vitest";
import type { Env } from "../../src/types";
import { TAVILY } from "../../src/providers";
import { createKeyPool, type KeyPool } from "../../src/key-pool";
import { getUsageStore } from "../../src/usage";
import { makeUpstreamSubscriber } from "../../src/queue/upstream-subscriber";
import { hourKey } from "../../src/domain";
import { makeConstantD1 } from "../helpers/fake-d1";

const fakeKV = { get: async () => null }; // 无配置 → 默认 postUse 10s

function envOf(): Env {
  return { DB: makeConstantD1([]).db, KV: fakeKV } as unknown as Env;
}

function poolOf(env: Env, id = "k1"): KeyPool {
  return createKeyPool(env, TAVILY.upstream, [
    { id, key: "tvly-" + id, name: "", status: "enabled", cooldown_until: null, suspended_cause: null, created_at: 1 },
  ]);
}

describe("makeUpstreamSubscriber", () => {
  it("success：冷却 post-use + usage success 各记一次", async () => {
    const env = envOf();
    const store = getUsageStore(env);
    const pool = poolOf(env);
    const sub = makeUpstreamSubscriber(env, () => pool);

    const at = Date.now();
    await sub({ type: "upstream-attempt-settled", keyId: "k1", provider: "tavily", cls: "success", at });

    expect(pool.getBreakerState("k1")).toEqual({ consecutive: 0, updated_at: at, created_at: at });
    expect(pool.getKeys()[0].cooldown_until).toBe(at + 10_000); // post-use 10s
    expect(pool.getKeys()[0].suspended_cause).toBe("post-use");
    await expect(store.readUpstreamTodayStats(["k1"], hourKey(at))).resolves.toEqual({
      k1: { success: 1, fail: 0 },
    });
  });

  it("rate-limit：疑似失效长冷却 + 记 usage fail", async () => {
    const env = envOf();
    const store = getUsageStore(env);
    const pool = poolOf(env, "k2");
    const sub = makeUpstreamSubscriber(env, () => pool);

    const at = Date.now();
    await sub({ type: "upstream-attempt-settled", keyId: "k2", provider: "tavily", cls: "rate-limit", at });

    expect(pool.getBreakerState("k2")).toBeNull(); // 不碰连续计数
    expect(pool.getKeys()[0].cooldown_until).toBe(at + 43_200_000); // invalidSec 12h
    expect(pool.getKeys()[0].suspended_cause).toBe("rate-limit");
    await expect(store.readUpstreamTodayStats(["k2"], hourKey(at))).resolves.toEqual({
      k2: { success: 0, fail: 1 },
    });
  });

  it("client-error：不处理（事件不入订阅，防御性忽略）", async () => {
    const env = envOf();
    const store = getUsageStore(env);
    const pool = poolOf(env, "k3");
    const sub = makeUpstreamSubscriber(env, () => pool);

    await sub({
      type: "upstream-attempt-settled",
      keyId: "k3",
      provider: "tavily",
      cls: "client-error",
      at: Date.now(),
    });

    expect(pool.getKeys()[0].cooldown_until).toBeNull();
    await expect(store.readUpstreamWeightSignal(["k3"])).resolves.toEqual({ k3: 0 });
  });
});
