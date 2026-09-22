// computeBreakerOutcome cause 归类单测：四族结果各自携带正确冷却因由，
// 供 KeyPool 写入 suspended_cause（可溯源）。纯策略无 IO。

import { describe, it, expect } from "vitest";
import { computeBreakerOutcome } from "../src/domain-services/breaker-policy";

const now = 1_000_000;
const POST_USE = 10;
const BASE = 600;
const INVALID = 43200;

describe("computeBreakerOutcome cause 归类", () => {
  it("success → cause=post-use，连续失败归零", () => {
    const o = computeBreakerOutcome(
      { consecutive: 3, updated_at: now - 1, created_at: now },
      "success",
      POST_USE, BASE, INVALID, now
    );
    expect(o.cause).toBe("post-use");
    expect(o.consecutive).toBe(0);
  });

  it("rate-limit → cause=post-use，不碰连续失败计数", () => {
    const o = computeBreakerOutcome(
      { consecutive: 2, updated_at: now, created_at: now },
      "rate-limit",
      POST_USE, BASE, INVALID, now
    );
    expect(o.cause).toBe("post-use");
    expect(o.consecutive).toBeNull();
  });

  it("auth-error → cause=invalid", () => {
    const o = computeBreakerOutcome(null, "auth-error", POST_USE, BASE, INVALID, now);
    expect(o.cause).toBe("invalid");
  });

  it("server-error → cause=breaker", () => {
    const o = computeBreakerOutcome(null, "server-error", POST_USE, BASE, INVALID, now);
    expect(o.cause).toBe("breaker");
  });
});
