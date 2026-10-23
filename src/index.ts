// 组装点：只负责把各子应用挂到总路由上，不含任何内联路由/中间件。
// - /         → publicApp（门户文本 + /help）
// - /         → proxyApp（数据面 /search /extract /reader，含 cors + authenticate）
// - /admin    → adminAuth（login/logout，无守卫，先挂避免被 admin 守卫遮蔽）
// - /admin    → admin（管理后台，含会话守卫 + CSRF 中间件）
// 数据面拆分为独立子应用后，cors 只作用于代理端点（行为收敛，见 routes/proxy.ts）。

import { Hono } from "hono";
import type { Env, AppVariables } from "./types";
import { publicApp } from "./routes/public";
import { proxyApp } from "./routes/proxy";
import { adminAuth } from "./routes/admin-auth";
import { admin } from "./admin";
import { bucketKey } from "./domain";

export type { Env } from "./types";
export { QueueDO } from "./queue/durable-object";

const app = new Hono<{ Bindings: Env; Variables: AppVariables }>();

app.route("/", publicApp);
app.route("/", proxyApp);
app.route("/admin", adminAuth);
app.route("/admin", admin);

// 用量保留：D1 无 TTL，定时清理超保留期的 UTC 时间桶行。桶价廉，每日一次足够。
// 30 天：程序里最长的历史读窗口是 Dashboard 趋势图的 5 天（admin/index.ts），
// 24h/今日/昨日与权重信号窗口更短，故更早的行不再被任何读路径消费。
const USAGE_RETENTION_DAYS = 30;

/**
 * 每批覆盖的桶数：15min 桶 → 4 桶/小时 → 96 桶/天，即一批 = 1 天。
 * 用「桶区间」而非 DELETE...LIMIT 分批：bucket 是索引前缀，按区间删可让每条 DELETE
 * 直接定位到该范围，避免 `DELETE ... LIMIT` 每批都要扫一遍索引挑候选行。
 * 一批 ≈ 一天，单语句工作量有界。
 */
const USAGE_PURGE_BUCKETS_PER_BATCH = 4 * 24;
/** 单次 cron 最多推进的批数（≈10 天/次）。积压会在后续每日 cron 中自然收敛。 */
const USAGE_PURGE_MAX_BATCHES = 10;

export default {
  fetch: app.fetch,
  async scheduled(
    _event: ScheduledEvent,
    env: Env,
    ctx: ExecutionContext
  ): Promise<void> {
    const cutoff = bucketKey(Date.now() - USAGE_RETENTION_DAYS * 86_400_000);
    // 先定位最早的历史桶：从最早处向前推进，避免历史不足/远超批次窗口时的空删或久拖。
    const head = await env.DB.prepare(
      "SELECT MIN(bucket) AS oldest FROM usage_counts"
    ).first<{ oldest: string | null }>();
    const oldest = head?.oldest;
    if (!oldest || oldest >= cutoff) return; // 无过期行

    // 按 kind 分别删：idx_usage_signal / idx_usage_window 均以 kind 为最左列，
    // 带 kind 条件才能走「SEARCH (kind=? AND bucket>? AND bucket<?)」范围定位；
    // 不带 kind 会退化成整索引 SCAN（同日区间实测全表 31 万行都读一遍）。
    const stepMs = USAGE_PURGE_BUCKETS_PER_BATCH * 15 * 60_000;
    let from = bucketKey(Date.parse(oldest + "Z"));
    for (let i = 0; i < USAGE_PURGE_MAX_BATCHES; i++) {
      const to = bucketKey(Date.parse(from + "Z") + stepMs);
      const upper = to < cutoff ? to : cutoff; // 最后一批收在 cutoff
      await env.DB.batch([
        env.DB.prepare(
          "DELETE FROM usage_counts WHERE kind=?1 AND bucket >= ?2 AND bucket < ?3"
        ).bind("upstream", from, upper),
        env.DB.prepare(
          "DELETE FROM usage_counts WHERE kind=?1 AND bucket >= ?2 AND bucket < ?3"
        ).bind("dist", from, upper),
      ]);
      if (upper >= cutoff) return; // 已推进到保留边界
      from = upper;
    }
  },
};
