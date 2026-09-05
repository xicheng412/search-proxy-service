// 共享测试基础设施：fake D1。
// 提供两种形态：
//   - makeConstantD1：任何查询都返回同一批行的"常量模式"（等价真实 GROUP BY/单表读），
//     仅计数（all/batch/run 各自），供 usage-store 等统计层测试。
//   - makeScriptedD1：按 prepare().bind().{all|first|run} 的执行顺序依次消费脚本响应，
//     并记录每次执行的 SQL/binds/op，供 storage 各域断言"发了什么、发了多少次"（含 batch 内容）。
// 两种都不真执行 SQL（不含状态变更语义）；需要验证 SQL 文本/绑定顺序时用 makeScriptedD1 的 log。

export type D1Op = "all" | "first" | "run" | "batch";

export interface D1Call {
  sql: string;
  binds: unknown[];
  op: D1Op;
}

export interface D1Step {
  /** all()/first() 返回的行；缺省为 []。 */
  results?: Record<string, unknown>[];
  /** run() 的变更行数；缺省 0。 */
  changes?: number;
}

export interface ConstantD1 {
  db: unknown;
  allCalls(): number;
  runCalls(): number;
  batchCalls(): number;
}

/** 常量模式 fake：任何 all() 都返回 rows，first() 返回 rows[0]，run() 恒 0 变更；batch() 空返回。 */
export function makeConstantD1(rows: Record<string, unknown>[]): ConstantD1 {
  let allCount = 0;
  let runCount = 0;
  let batchCount = 0;
  const bound = {
    async all() {
      allCount += 1;
      return { results: rows, success: true } as never;
    },
    async first() {
      return rows[0] ?? null;
    },
    async run() {
      runCount += 1;
      return { meta: { changes: 0 } } as never;
    },
  };
  const db = {
    prepare() {
      return {
        bind() {
          return bound;
        },
      };
    },
    async batch(stmts: unknown[]) {
      batchCount += 1;
      return stmts.map(() => ({ results: [], success: true }));
    },
  };
  return { db, allCalls: () => allCount, runCalls: () => runCount, batchCalls: () => batchCount };
}

export interface ScriptedD1 {
  db: unknown;
  log(): D1Call[];
}

/** 脚本模式 fake：按调用顺序逐条消费 D1Step；未消费到的调用返回空结果。log 记录每次执行。 */
export function makeScriptedD1(steps: D1Step[]): ScriptedD1 {
  const log: D1Call[] = [];
  let i = 0;
  const take = () => (i < steps.length ? steps[i++] : { results: [] });

  const bound = (sql: string, binds: unknown[]) => ({
    sql,
    binds,
    async all() {
      const s = take();
      log.push({ sql, binds, op: "all" });
      return { results: s.results ?? [], success: true };
    },
    async first() {
      const s = take();
      log.push({ sql, binds, op: "first" });
      return s.results?.[0] ?? null;
    },
    async run() {
      const s = take();
      log.push({ sql, binds, op: "run" });
      return { meta: { changes: s.changes ?? 0 } };
    },
  });

  const db = {
    prepare(sql: string) {
      return {
        bind(...binds: unknown[]) {
          return bound(sql, binds);
        },
      };
    },
    async batch(stmts: { sql: string; binds: unknown[] }[]) {
      log.push({ sql: "", binds: [], op: "batch" });
      for (const s of stmts) {
        take();
        log.push({ sql: s.sql, binds: s.binds, op: "run" });
      }
      return stmts.map(() => ({ results: [], success: true }));
    },
  };

  return { db, log: () => log };
}
