-- 0006_dist_keys_created_at_api_key: 支撑分发 Keys 管理页 keyset 分页的复合索引。
-- 仅新增索引；不改变表、字段、数据或既有索引（上游同型见 0002）。
-- 覆盖 (created_at, api_key) 稳定排序与游标边界，避免深页 ORDER BY 全表扫描。
CREATE INDEX idx_distributed_keys_created_at_api_key ON distributed_keys(created_at, api_key);
