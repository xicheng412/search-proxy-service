-- 0002_upstream_keys_provider_created_id: 支撑管理页 keyset 分页的复合索引。
-- 仅新增索引；不改变表、字段、数据或既有索引。
-- 覆盖 provider 过滤 + (created_at,id) 稳定排序/游标边界，避免深页全表扫描。
CREATE INDEX idx_upstream_keys_provider_created_id
ON upstream_keys(provider, created_at, id);
