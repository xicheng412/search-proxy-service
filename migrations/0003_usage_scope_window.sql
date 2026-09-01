-- 用量时间窗查询索引：优先支持 kind = ? / scope = ?/IN(...) / hour >= ? 过滤。
-- provider 列在范围列之后，用于 GROUP BY 返回聚合所需维度。
-- 不包含 success/fail，避免在高频 UPSERT 时扩大索引与写放大。
CREATE INDEX idx_usage_scope_window
ON usage_counts (kind, scope, hour, provider);
