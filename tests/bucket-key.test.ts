// bucketKey / BUCKET_MS / utcTodayStart 的值语义可执行验证。

import { describe, it, expect } from "vitest";
import { bucketKey, BUCKET_MS, utcTodayStart } from "../src/domain";

describe("bucketKey", () => {
  it("对齐 15min 网格：epoch 与边界前后毫秒", () => {
    expect(bucketKey(0)).toBe("1970-01-01T00:00");
    expect(bucketKey(Date.parse("2026-09-01T08:14:59.999Z"))).toBe("2026-09-01T08:00");
    expect(bucketKey(Date.parse("2026-09-01T08:15:00Z"))).toBe("2026-09-01T08:15");
  });

  it("输出长度恒为 16", () => {
    for (let i = 0; i < 100; i++) {
      expect(bucketKey(Math.floor(Math.random() * 1e12))).toHaveLength(16);
    }
  });

  it("任意两时刻的字符串序与时间序一致（抽样 100 对随机毫秒）", () => {
    for (let i = 0; i < 100; i++) {
      const a = Math.floor(Math.random() * 1e12);
      const b = Math.floor(Math.random() * 1e12);
      const ka = bucketKey(a);
      const kb = bucketKey(b);
      if (a < b) expect(ka <= kb).toBe(true);
      else if (a > b) expect(ka >= kb).toBe(true);
    }
  });
});

describe("utcTodayStart", () => {
  it("输出是合法时间桶键：长度 16、UTC 00:00、落在 BUCKET_MS 网格上", () => {
    const now = Date.now();
    const s = utcTodayStart(now);
    expect(s).toHaveLength(16);
    expect(s.endsWith("T00:00")).toBe(true);
    // :00 是 15min 网格上的点：bucketKey 解析回同值，且毫秒对齐 BUCKET_MS。
    expect(bucketKey(Date.parse(s + "Z"))).toBe(s);
    expect(Date.parse(s + "Z") % BUCKET_MS).toBe(0);
  });
});
