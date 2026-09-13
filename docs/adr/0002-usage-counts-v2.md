# ADR-0002: usage_counts 去 dist 哨兵 + 热路径信号覆盖索引

> **Status**: accepted（2026-09-13。记录 `migrations/0004_usage_counts_v2.sql` 及配套代码清理；正面推翻 ADR-0001 §55 对选 key 权重信号查询的"不扩覆盖索引"判据）

## 决策

1. 重建 `usage_counts`（0004）：PK 由 `(kind, scope, provider, hour)` 收紧为 `(kind, scope, hour)`；`provider` 改为可空——upstream 保留真实 provider，dist 不再写哨兵 `'*'` 而写 NULL。
2. 索引三棵：
   - `idx_usage_signal  (kind, hour, scope, fail)` —— 新增，选 key 权重信号 index-only；
   - `idx_usage_window  (kind, hour, provider)` —— 由 `(kind, provider, hour)` 重排，hour 范围可用；
   - `idx_usage_scope   (kind, scope, hour, provider)` —— 沿用 0003 列序。
3. `mergeUsage` UPSERT 冲突键改为 `(kind, scope, hour)`（跟随新 PK）。**顺序约束：迁移必须先于新代码部署。**
4. 清理：删 `DIST_PROVIDER` 常量、`sumUsage` 死代码；读侧 provider 归一（NULL 不落 JS `"null"` 组名）。

## 上下文 / 问题

- **dist 无 provider 维度却被迫占位**：分发 key 不带 provider 属性（前缀在调用时自选），`kind='dist'` 行本无 provider 信息；旧 schema 因 `provider NOT NULL 且入 PK`（0001）每行强写哨兵 `'*'` —— 写侧死占位、读侧处处"无视其值"。
- **热路径信号查询占 D1 大量时间**：`WHERE kind='upstream' AND hour>=? GROUP BY scope`（扫 fail）无任何 hour 前缀索引可用，只能按 kind 前缀全扫 90d 历史（key × provider × 2160 桶）。这反证 ADR-0001 "瓶颈是往返不是行数、不为 index-only scan 扩覆盖索引"对该查询前提不成立——它恰恰是行数瓶颈。
- 两者都借"反正是加索引要动库"之机一并处理。

## 替代方案与取舍

| 方案 | 结论 |
|---|---|
| 仅加窄索引 `(kind, hour)` | 能裁剪 hour 范围但仍回表取 fail；反正重建表，直接做覆盖更彻底 |
| `scope IN (...)` 过滤 | 次数换单次成本、方向反（候选集变动使缓存失效，次数反弹），不做 |
| 内存滑动窗口彻底去 D1 读 | 更激进（evict 丢窗口是语义分叉）；本次只换执行计划不改架构，后续单独评估 |

## 细节与顺序约束（关键）

- 迁移 SQL 见 `migrations/0004_usage_counts_v2.sql`：新建 `usage_counts_v2` → 搬迁 → `DROP` 旧表 → `RENAME` → 建索引。搬迁对 dist 按 `(kind,scope,hour)` 归并求和（历史存在 `provider='tavily'` 的 dist 脏行与 `'*'` 并存，预检确认仅 1 组同键重复；dist 计数本无 provider 维度，求和与读侧既有合并语义等效）；upstream 直拷原值，若出现同键重复由 UNIQUE 冲突使整迁移回滚暴露，不做静默合并。
- 0004 后 PK 变 `(kind, scope, hour)`，旧 `mergeUsage` 的 `ON CONFLICT(kind,scope,provider,hour)` **不再匹配任何唯一约束（SQLite 语法报错）** → 旧代码在迁移后 flush 写全部失败。
- 因此部署顺序强制：**先 apply 0004，再部署新代码**。窗口期（旧代码 + 新表，即部署传播的秒-分钟）新写入静默失败 = 既有"写失败静默、统计有损"语义；旧读 SQL 无冲突键，在新表上正确。
- 不能反过来（新代码写 dist NULL 违反旧表 `provider NOT NULL`）。
- 数据搬迁：单条 `INSERT...SELECT`（库 <10M）；D1 migration 单文件事务原子回滚。

## 代价与风险

- **写放大**：索引 +1 棵（`idx_usage_signal`）；同时 PK 由 4 列缩 3 列、删掉 dist `'*'` 死占位、`idx_usage_window` 由 3 列变窄 —— 净写放大基本持平、略降。
- **不变量**：PK `(kind, scope, hour)` 依赖"上游 key id 全局唯一（一个 scope 只属一个 provider）"。迁移前预检 `COUNT(*) GROUP BY kind,scope,hour HAVING COUNT(*)>1`；理论不应冲突，若出现需人工处理。
- **重建表期间写**：D1 串行锁下 flush 写失败由既有有损语义兜底，无需额外保护。

## 关联

- `docs/architecture.md` §5.1（表结构/索引）、§5.2.1（索引判据例外）、§5.2.2（kind='dist' provider NULL 表述）。
- 推翻 ADR-0001 §55 对**该条查询**的"不扩覆盖索引"判据——以本节例外为准；其余查询仍守原判据。
