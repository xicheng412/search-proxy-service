-- 0004_usage_counts_v2: 重建 usage_counts，去除 dist 行 provider 哨兵 '*'，重排/新增索引。
--
-- 背景：
--   dist 线（kind='dist'）无 provider 维度，旧 schema 因 provider NOT NULL 且入 PK（0001）
--   被迫写哨兵 '*'。本次把 provider 改为可空：dist 写 NULL，upstream 保留真实 provider；
--   PK 由 (kind,scope,provider,hour) 收紧为 (kind,scope,hour)。依赖不变量：上游 key id 全局唯一，
--   一个 scope 只属一个 provider（迁移前已预检无 (kind,scope,hour) 重复行）。
--
-- 索引语义：
--   idx_usage_scope   沿用 0003 的 idx_usage_scope_window (kind,scope,hour,provider) 列序。
--   idx_usage_window  由 0001 的 (kind,provider,hour) 重排为 (kind,hour,provider)：
--                    让 hour>= 范围可用，dashboard 折线（GROUP BY hour,provider）按序聚合、
--                    ORDER BY hour 免排序。
--   idx_usage_signal  新增覆盖索引 (kind,hour,scope,fail)：热路径选 key 权重信号
--                    （WHERE kind=? AND hour>=? GROUP BY scope 扫 fail）原本无 hour 前缀索引、
--                    全扫 kind 历史行；新索引把扫描裁到窗口小时桶且免回表（index-only）。

-- 1) 新表
CREATE TABLE usage_counts_v2 (
  kind     TEXT NOT NULL,      -- 'upstream' | 'dist'
  scope    TEXT NOT NULL,      -- upstream key id | dist api_key
  provider TEXT,               -- NULL = dist 无 provider 维度；upstream = 真实 provider
  hour     TEXT NOT NULL,      -- 'YYYY-MM-DDTHH:00'（UTC）
  success  INTEGER NOT NULL DEFAULT 0,
  fail     INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (kind, scope, hour)
);

-- 2) 搬迁：dist '*'/'tavily' 历史脏行 → NULL 并归并（dist 计数本无 provider 维度、读侧原就跨
--    provider 合计，同 (kind,scope,hour) 求和在语义与展示上等效）；upstream 直拷原值。
--    注：预检确认除该组 dist 外无 (kind,scope,hour) 重复；upstream 若出现重复将由 UNIQUE 冲突
--    使整迁移回滚暴露，不做静默合并。
INSERT INTO usage_counts_v2 (kind, scope, provider, hour, success, fail)
SELECT kind, scope, NULL, hour, SUM(success), SUM(fail)
FROM usage_counts
WHERE kind = 'dist'
GROUP BY kind, scope, hour;

INSERT INTO usage_counts_v2 (kind, scope, provider, hour, success, fail)
SELECT kind, scope, provider, hour, success, fail
FROM usage_counts
WHERE kind = 'upstream';

-- 3) 换表（DROP 连同旧表全部索引一并移除）
DROP TABLE usage_counts;
ALTER TABLE usage_counts_v2 RENAME TO usage_counts;

-- 4) 重建 + 新增索引
CREATE INDEX idx_usage_scope  ON usage_counts (kind, scope, hour, provider);
CREATE INDEX idx_usage_window ON usage_counts (kind, hour, provider);
CREATE INDEX idx_usage_signal ON usage_counts (kind, hour, scope, fail);
