# ADR-0003: 用量桶 15 分钟化 + Dashboard 三卡口径统一 + 迁移标准化

> **Status**: accepted（2026-10。记录 `migrations/0007_usage_bucket_15m.sql` 及配套代码清理/口径收敛；
> 正面推翻 ADR-0001 §5 与 ADR-0002 的「每 key 每日 ≤24 行」成本基线，并统一 Dashboard 三卡口径）

## 决策

1. 桶宽从 1 小时改为 **15 分钟**（`BUCKET_MS`，UTC 对齐），主键列 `hour` → `bucket`，键格式 `YYYY-MM-DDTHH:MM`。
   读侧无感：存储、读产品、前端都只认「时间桶」，不再假设 1 小时。
2. Dashboard 三张卡（最近 24h / 今日 / 昨日）改由**服务端** `readDistSummaries` 按 UTC 区间计算并注入，
   前端只显示、不再按浏览器本地时区归日（消除部署后新 isolate 首渲缓存/pending 与前端归日叠加导致的巨量假数）。
3. 迁移标准化：以 `wrangler d1 migrations` 为唯一权威（`wrangler.toml` 显式钉住 `migrations_dir` /
   `migrations_pattern` / `migrations_table`）；`scripts/migrate.sh` 负责「apply + 断言无 pending 残留」，
   `scripts/deploy.sh` 改为先迁移后部署。

## 上下文 / 问题

- **Nyquist**：1h 桶无法还原真实到达形状（无法区分峰值是否为子小时突发）；15min 是 24h/今日等展示窗口
  与写放大之间的合理折中。
- **Dashboard 三卡时区口径分叉**：旧实现由浏览器本地时区从 `dist` 序列重新归日，而服务端「当日」是 UTC 日；
  部署后新 isolate 首次渲染时缓存/pending 与前端归日逻辑叠加，出现与数据库不符的巨量数字（趋势图正常，
  因为它只按点画、不做归日求和）。修复方向是服务端算、前端显示。
- 历史数据（保留期内的小时行）必须在迁移中处理，且总量严格守恒。

## 替代方案与取舍

| 方面 | 方案 | 结论 |
|---|---|---|
| 历史 1h 行拆分 | 等比拆成 4 个 15min 桶，余数（`success % 4`）全归最后一段 | 任意整数下总量严格守恒；桶内分布是**均匀化近似值**，非观测值。选它因迁移一次性、不可逆且分布不可知，均匀假设是唯一可验证守恒的保守选择 |
| 零丢失切换 | 两步发布（0007 加 `bucket` 列保留 `hour`，0008 切代码后再删 `hour`） | 不采用：保留期数据量小、`deploy.sh` 已保证先迁移后部署，窗口期旧代码 flush 写失败由既有「写失败静默、统计有损」语义兜底 |
| Dashboard 三卡 | 前端按时区归日 vs 服务端 UTC 汇总 | 服务端：单一口径、无部署期假数；前端只显示 |
| 节流阈值 | 保持 30min vs 改 `BUCKET_MS` | 改 `BUCKET_MS`（15min）：与桶宽同量级，跨 isolate 最多 1 个桶不可见；写频率提高到 ≤15min/isolate，若 D1 写配额成为问题可回退 30min |

## 细节与顺序约束（关键）

- 迁移 SQL 见 `migrations/0007_usage_bucket_15m.sql`，沿用 0004 的「建新表 → 搬迁 → 删旧表 → 改名 → 建索引」范式。
  前置不变量：`usage_counts.hour` 全部形如 `YYYY-MM-DDTHH:00`（0001 起唯一写入路径 `hourKey()`，成立）；
  `substr(hour,1,14)||'00'/'15'/'30'/'45'` 得到 16 字符桶键。
- 拆分公式：前三段各 `success/4`（整除），第四段 `success - 3*(success/4)` → 任意整数守恒；fail 同理。
- 0007 后 PK 变 `(kind, scope, bucket)`，旧 `mergeUsage` 的 `ON CONFLICT(kind,scope,hour)` 不再匹配任何唯一约束
  （SQLite 语法报错）→ **部署顺序强制：先 apply 0007，再部署新代码**（`scripts/deploy.sh` 已内置「先迁移后部署」）。
- `flushIntervalMs` 默认改 `BUCKET_MS`；`flushMaxPending` 保持 256。
- `today.ts` 两处 `collapsePending(..., null, ...)` 改为 `minBucket`——去掉「叠加所有 pending」口径，
  与 `series` 统一为只叠加 `bucket >= minBucket` 的条目。

## 代价与风险

- **行数 ×4**：每 key 每日从 ≤24 行 → ≤96 行；`usage_counts` 行数/索引、`idx_usage_signal` 扫描量约 ×4（ADT-0001 §5 / ADR-0002 的「瓶颈不在行数」基线被推翻为「×4 后仍小」——保留期 90d、实际只留数周，D1 单请求限制内 `INSERT...SELECT` 四次全表扫描可承受；若线上 `usage_counts` 超 ~50 万行，改为分页批量搬迁）。
- **写频率**：flush 节流从 30min → 15min，D1 写请求上限约 ×2；若配额吃紧，回退 30min 并在 §5.2 写明「最多 2 个桶跨 isolate 不可见」。
- **重建表期间写**：D1 串行锁下 flush 写失败由既有有损语义兜底，无需额外保护。
- **迁移 grep 文案**：`scripts/migrate.sh` 的「无 pending」断言依赖 `wrangler d1 migrations list` 输出中 `pending` 字样；若 wrangler 改变输出格式需同步校准（实现时已按 `grep -qi "pending"` 做，见脚本注释）。

## 关联

- `CONTEXT.md`：**时间桶** 词目替代 **小时桶**；「当日」「写回式近似统计」口径更新。
- `docs/architecture.md` §5.1（表/索引 `hour`→`bucket`）、§5.2（精度契约 ≥15min + `readDistSummaries`）、§5.2.1（≤96 行基线）、§5.2.2（三卡口径在服务端）。
- `docs/domain-concepts.md` §1（`ScheduledPurgeUsage` 改 `bucket < cutoff`）、§4（新增「usage_counts 全 15 分钟桶」不变量）。
- `src/domain.ts`（`bucketKey` / `BUCKET_MS`）、`src/usage/reads/series.ts`（`readDistSummaries` / `sumDistInRange`）。
- 正面推翻 ADR-0001 §5 与 ADR-0002 的「每 key 每日 ≤24 行」成本基线——以本文为准（现 ≤96 行，时间桶聚合）。
