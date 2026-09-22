// Availability 值语义单测：availabilityOf 把 CoreKey 原始字段（status+cooldown_until+suspended_cause）
// 派生为统一「冷却/停用」值对象；isSelectableAt 是选 key 的统一谓词事实源（selection.isCandidate 委托它）。

import { describe, it, expect } from "vitest";
import { availabilityOf, isSelectableAt, type CoreKey } from "../src/domain";

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

describe("isSelectableAt 选 key 谓词", () => {
  it("available → true", () => {
    expect(isSelectableAt({ kind: "available" }, 1000)).toBe(true);
  });

  it("disabled → false", () => {
    expect(isSelectableAt({ kind: "disabled" }, 1000)).toBe(false);
  });

  it("suspended 未到期 → false", () => {
    expect(isSelectableAt({ kind: "suspended", until: 5000, cause: "breaker" }, 1000)).toBe(false);
  });

  it("suspended 已到期 → true", () => {
    expect(isSelectableAt({ kind: "suspended", until: 900, cause: "breaker" }, 1000)).toBe(true);
  });

  it("suspended 恰到期（until===now）→ true（边界含等号）", () => {
    expect(isSelectableAt({ kind: "suspended", until: 1000, cause: "post-use" }, 1000)).toBe(true);
  });
});
