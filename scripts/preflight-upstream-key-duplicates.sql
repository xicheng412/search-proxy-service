-- 只读预检：上游 key 在同一 provider 内是否有重复值。
-- 用法：wrangler d1 execute search-proxy --remote --file=scripts/preflight-upstream-key-duplicates.sql
-- 输出不包含 key 明文；ids 用于在管理页定位并人工决定保留哪一行。
SELECT provider,
       COUNT(*) AS duplicate_count,
       GROUP_CONCAT(id) AS ids
FROM upstream_keys
GROUP BY provider, key
HAVING COUNT(*) > 1;