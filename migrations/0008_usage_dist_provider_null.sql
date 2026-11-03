-- 0008_usage_dist_provider_null: 修复 dist 行 provider 写成空串的历史数据。
--
-- 0004 后 dist（kind='dist'）无 provider 维度，约定写 NULL。但 usage/core.ts 的 flush
-- 从内存键解包时保留了空串，导致新写入行实际落成 provider=''。当前读侧按 scope 汇总
-- 全部 provider，数字未分叉；但 `provider IS NULL` 的口径已被破坏，故回填统一。
--
-- PK 是 (kind, scope, bucket)，不含 provider，本次 UPDATE 不会触发唯一冲突。
-- 先确认影响行数（迁移前可在 remote 执行）：
--   SELECT COUNT(*) FROM usage_counts WHERE kind='dist' AND provider='';
UPDATE usage_counts
SET provider = NULL
WHERE kind = 'dist' AND provider = '';