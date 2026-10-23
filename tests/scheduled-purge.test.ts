// cron 用量清理的可执行验证：保留期 cutoff、从最早桶推进、区间分批、批次上限。

import { describe, it, expect, vi, afterEach } from "vitest";
import worker from "../src/index";
import { bucketKey } from "../src/domain";
import type { Env } from "../src/types";

interface Call {
  kind: "first" | "run";
  sql: string;
  binds: unknown[];
}

/**
 * 构造只服务 "SELECT MIN(bucket)" 与 "DELETE ... bucket >= ?1 AND bucket < ?2" 的 fake D1。
 * 记录每次执行的 SQL 与绑定，供断言 cutoff / 区间推进 / 退出条件。
 */
function makePurgeDb(oldest: string | null) {
  const calls: Call[] = [];
  const make = (sql: string, binds: unknown[]) => ({
    sql,
    binds,
    async first() {
      calls.push({ kind: "first", sql, binds });
      return oldest === null ? null : { oldest };
    },
    async run() {
      calls.push({ kind: "run", sql, binds });
      return { meta: { changes: 0 } };
    },
    bind: (...b: unknown[]) => make(sql, b),
  });
  const db = {
    prepare: (sql: string) => make(sql, []),
    // DB.batch：逐条执行封装的语句（这里直接调用其 run，记录等价的 SQL/binds）。
    async batch(stmts: Array<{ sql: string; binds: unknown[] }>) {
      for (const s of stmts) calls.push({ kind: "run", sql: s.sql, binds: s.binds });
      return stmts.map(() => ({ meta: { changes: 0 } }));
    },
  };
  return { db, calls };
}

async function runScheduled(db: unknown) {
  const env = { DB: db } as unknown as Env;
  await worker.scheduled!(
    {} as ScheduledEvent,
    env,
    { waitUntil: () => {} } as unknown as ExecutionContext
  );
}

const NOW = "2026-10-23T03:00:00Z";

describe("scheduled 用量清理", () => {
  afterEach(() => vi.useRealTimers());

  it("无过期行（表空或最早桶已在保留期内）→ 不发 DELETE", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date(NOW));

    const empty = makePurgeDb(null);
    await runScheduled(empty.db);
    expect(empty.calls.filter((c) => c.kind === "run")).toHaveLength(0);

    // 最早桶 = 31 天前 → 仍在 30 天窗口内
    const recent = makePurgeDb(bucketKey(Date.parse(NOW) - 30 * 86_400_000));
    await runScheduled(recent.db);
    expect(recent.calls.filter((c) => c.kind === "run")).toHaveLength(0);
  });

  it("cutoff = 今天 - 30 天（15min 对齐），首批从最早桶起算", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date(NOW));
    const oldest = "2026-09-20T11:00"; // 早于 cutoff，且只需 3 天即可收敛
    const { db, calls } = makePurgeDb(oldest);
    await runScheduled(db);

    const cutoff = bucketKey(Date.parse(NOW) - 30 * 86_400_000);
    const runs = calls.filter((c) => c.kind === "run");
    expect(runs.length).toBeGreaterThan(0);
    // 每批含 upstream + dist 两条 DELETE，均带 kind 以走索引范围定位
    expect(runs[0].sql).toContain("kind=?1 AND bucket >= ?2 AND bucket < ?3");
    expect(runs[0].binds[0]).toBe("upstream");
    expect(runs[0].binds[1]).toBe(oldest);
    // 每批 1 天 = 96 个 15min 桶；首批上界 = oldest + 1 天
    expect(runs[0].binds[2]).toBe(bucketKey(Date.parse(oldest + "Z") + 86_400_000));
    expect(runs[1].binds[0]).toBe("dist");
    // 收敛时最后一批必须收在 cutoff
    expect(runs[runs.length - 1].binds[2]).toBe(cutoff);
  });

  it("积压很大时受批次上限约束（单次 cron 不跑死，剩余留给下次）", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date(NOW));
    // 最早桶 = 200 天前 → 远超 10 天/次的推进能力
    const oldest = bucketKey(Date.parse(NOW) - 200 * 86_400_000);
    const { db, calls } = makePurgeDb(oldest);
    await runScheduled(db);
    const runs = calls.filter((c) => c.kind === "run");
    expect(runs).toHaveLength(20); // 10 批 × (upstream+dist)
    // 未推进到 cutoff（说明还有剩余积压）
    const cutoff = bucketKey(Date.parse(NOW) - 30 * 86_400_000);
    expect(runs[runs.length - 1].binds[2]).not.toBe(cutoff);
  });

  it("积压 3 天时 3 批即可收敛到 cutoff 并停止", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date(NOW));
    const oldest = bucketKey(Date.parse(NOW) - 33 * 86_400_000); // 需删 3 天
    const { db, calls } = makePurgeDb(oldest);
    await runScheduled(db);
    const runs = calls.filter((c) => c.kind === "run");
    expect(runs.length).toBe(6); // 3 批 × 2 kind
    expect(runs[runs.length - 1].binds[2]).toBe(bucketKey(Date.parse(NOW) - 30 * 86_400_000));
  });
});