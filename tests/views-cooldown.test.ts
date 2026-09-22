// 冷却倒计时文案与 SSR 徽章渲染契约：formatRemaining 是两档文案的唯一服务端定义，
// static/admin.js 的 cooldownText 与其逐字符一致（防两侧漂移）；listFragment 必须把
// 绝对截止戳输出为 data-cooldown-until 供前端 tick。

import { describe, it, expect } from "vitest";
import { formatRemaining } from "../src/views/index";
import { tavilyListFragment } from "../src/views/tavily";
import { exaListFragment } from "../src/views/exa";
import type { TavilyKey } from "../src/domain";

describe("formatRemaining（≥100s→min / <100s→s，ceil 取整；0→-）", () => {
  it("≥100s 进分钟档，ceil 到整数分钟", () => {
    expect(formatRemaining(100_000)).toBe("冷却：2min"); // 100s → 2min（估算）
    expect(formatRemaining(3_590_000)).toBe("冷却：60min"); // 59.83min
    expect(formatRemaining(10_800_000)).toBe("冷却：180min"); // 3h
  });

  it("<100s 显示秒，ceil 到整数秒；≤0 显示 -", () => {
    expect(formatRemaining(98_999)).toBe("冷却：99s");
    expect(formatRemaining(1)).toBe("冷却：1s");
    expect(formatRemaining(0)).toBe("-");
  });

  it("100s 边界两侧连续无跳空", () => {
    expect(formatRemaining(99_999)).toBe("冷却：2min");
    expect(formatRemaining(98_999)).toBe("冷却：99s");
  });
});

describe("Tavily/Exa 列表冷却徽章 SSR", () => {
  const now = 1_700_000_000_000;
  const pagination = { page: 1, first: null, previous: null, next: null };
  const coolingKey: TavilyKey = {
    id: "k1",
    key: "tvly-X",
    name: "",
    status: "enabled",
    cooldown_until: now + 150_000, // → 冷却：3min
    suspended_cause: "breaker",
    created_at: 1,
  };
  const idleKey: TavilyKey = {
    id: "k2",
    key: "tvly-Y",
    name: "",
    status: "enabled",
    cooldown_until: null,
    suspended_cause: null,
    created_at: 2,
  };
  const keys = [coolingKey, idleKey];

  it("冷却中输出 data-cooldown-until 绝对戳 + 倒计时文案", () => {
    for (const fragment of [
      tavilyListFragment(keys, {}, "csrf", now, pagination),
      exaListFragment(keys, {}, "csrf", now, pagination),
    ]) {
      expect(fragment).toContain(`data-cooldown-until="${now + 150_000}"`);
      expect(fragment).toContain("冷却：3min");
      expect(fragment).toContain('title="熔断冷却"'); // 冷却徽章带因由 tooltip
    }
  });

  it("非冷却行仍为 <span class=\"muted\">-</span>", () => {
    for (const fragment of [
      tavilyListFragment(keys, {}, "csrf", now, pagination),
      exaListFragment(keys, {}, "csrf", now, pagination),
    ]) {
      expect(fragment).toContain('<span class="muted">-</span>');
      expect(fragment.match(/data-cooldown-until/g)?.length).toBe(keys.length - 1);
    }
  });
});
