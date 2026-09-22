-- 0005_upstream_suspended_cause: 冷却统一为"定时解除的停用"，记录冷却因由。
-- status=人工车道；cooldown_until=机器车道；suspended_cause=冷却因由（post-use|breaker|invalid，NULL=未知/未冷却）。
-- Availability 由三者派生。仅新增可空列：无数据回填、无索引变化、对旧代码向后兼容。
ALTER TABLE upstream_keys ADD COLUMN suspended_cause TEXT;
