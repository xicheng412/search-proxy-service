-- 0001_init: 实体数据从 KV 迁到 D1。
-- 基础配置（breaker_config/queue_config）与会话仍留 KV，不进此库。

-- 上游 key（真实 Tavily/Exa 供应商凭据）。provider 作维度字段，未来加 provider 只加值。
CREATE TABLE upstream_keys (
  provider      TEXT NOT NULL,          -- 'tavily' | 'exa' | 未来
  id            TEXT NOT NULL,          -- 上游 key id
  key           TEXT NOT NULL,          -- 上游真实 key
  name          TEXT NOT NULL DEFAULT '',
  status        TEXT NOT NULL DEFAULT 'enabled',  -- KeyStatus
  cooldown_until INTEGER,               -- ms 时间戳；NULL = 未冷却
  created_at    INTEGER NOT NULL,       -- ms 时间戳
  PRIMARY KEY (provider, id)
);

-- 分发 key（对外分发给下游的客户凭据）。
CREATE TABLE distributed_keys (
  api_key    TEXT PRIMARY KEY,
  note       TEXT NOT NULL DEFAULT '',
  status     TEXT NOT NULL DEFAULT 'enabled',
  created_at INTEGER NOT NULL
);

-- 用量小时桶（UTC）。每 (kind, scope, provider, hour) 一行聚合计数。
-- calls := success + fail（派生，不单列）。
-- kind: 'upstream'=scope 为上游 key id；'dist'=scope 为分发 api_key。
CREATE TABLE usage_counts (
  kind     TEXT NOT NULL,
  scope    TEXT NOT NULL,
  provider TEXT NOT NULL,
  hour     TEXT NOT NULL,               -- 'YYYY-MM-DDTHH:00'（UTC）
  success  INTEGER NOT NULL DEFAULT 0,
  fail     INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (kind, scope, provider, hour)
);
-- 跨 scope 按时间窗汇总（今日/最近N小时/provider 拆分）。
CREATE INDEX idx_usage_window ON usage_counts (kind, provider, hour);

-- 熔断状态：每上游 key 的连续失败计数 + 更新时间（模拟 KV 的 10min TTL 窗口）。
CREATE TABLE breaker_state (
  id          TEXT PRIMARY KEY,         -- 上游 key id
  consecutive INTEGER NOT NULL DEFAULT 0,
  updated_at  INTEGER NOT NULL,         -- ms；距 now > 10min 视为已恢复（按 0 处理）
  created_at  INTEGER NOT NULL
);
