// Availability 值语义单测：availabilityOf 把 CoreKey 原始字段（status+cooldown_until+suspended_cause）
// 派生为统一「冷却/停用」值对象；`availabilityOf(...).kind === "available"` 是选 key 的唯一谓词。

import { describe, it, expect } from "vitest";
import { availabilityOf, type CoreKey } from "../src/domain";

function key(overrides: Partial<CoreKey> = {}): CoreKey {
  return {
    id: "k",
    key: "tvly-x",
    name: "",
    status: "enabled",
    cooldown_until: null,
    suspended_cause: null,
    created_at: 1,
    ...overrides,
  };
}

describe("availabilityOf 派生", () => {
  it("enabled 且未冷却 → available", () => {
    expect(availabilityOf(key(), 1000)).toEqual({ kind: "available" });
  });

  it("disabled → disabled（即使带冷却字段）", () => {
    expect(
      availabilityOf(key({ status: "disabled", cooldown_until: 9999, suspended_cause: "breaker" }), 1000)
    ).toEqual({ kind: "disabled" });
  });

  it("冷却中 → suspended，until=cooldown_until、cause 透传", () => {
    expect(
      availabilityOf(key({ cooldown_until: 5000, suspended_cause: "breaker" }), 1000)
    ).toEqual({ kind: "suspended", until: 5000, cause: "breaker" });
  });

  it("冷却中且 cause 未知（null）→ suspended cause=null", () => {
    expect(availabilityOf(key({ cooldown_until: 5000, suspended_cause: null }), 1000)).toEqual({
      kind: "suspended",
      until: 5000,
      cause: null,
    });
  });

  it("冷却已到期 → available", () => {
    expect(
      availabilityOf(key({ cooldown_until: 900, suspended_cause: "invalid" }), 1000)
    ).toEqual({ kind: "available" });
  });
});
