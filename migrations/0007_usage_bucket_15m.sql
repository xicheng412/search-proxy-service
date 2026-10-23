-- 0007_usage_bucket_15m: 桶粒度 1h → 15min；主键列 hour 改名 bucket（SQLite 不可原地改列，走重建）。
-- 历史小时行按等比拆分到 4 个 15min 桶：前三段各取 success/4，第四段取 success - 3*(success/4)，
-- 余数全归最后一段 → 任意整数下总量严格守恒。历史段的 15min 分布是均匀化的近似值，不是观测值。
--
-- 前置不变量：usage_counts.hour 全部形如 'YYYY-MM-DDTHH:00'（0001 起唯一写入路径是 hourKey()，
-- 成立）。substr(hour,1,14) 取到 'YYYY-MM-DDTHH:'，拼接 '00'/'15'/'30'/'45' 得到 16 字符桶键。
--
-- 索引语义（列序 from hour → bucket）：
--   idx_usage_scope   沿用 0003 的 (kind,scope,hour,provider) 列序。
--   idx_usage_window  (kind,hour,provider) → (kind,bucket,provider)：让 bucket>= 范围可用，
--                     dashboard 折线（GROUP BY bucket,provider）按序聚合、ORDER BY bucket 免排序。
--   idx_usage_signal  (kind,hour,scope,fail) → (kind,bucket,scope,fail)：热路径权重信号
--                     （WHERE kind=? AND bucket>=? GROUP BY scope 扫 fail）裁到窗口桶且免回表。

-- 1) 新表
CREATE TABLE usage_counts_v2 (
  kind     TEXT NOT NULL,
  scope    TEXT NOT NULL,
  provider TEXT,
  bucket   TEXT NOT NULL,          -- 'YYYY-MM-DDTHH:MM'（UTC，对齐 15min）
  success  INTEGER NOT NULL DEFAULT 0,
  fail     INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (kind, scope, bucket)
);

-- 2) 搬迁：历史小时行等比拆成 4 个 15min 桶，余数全归最后一段（总量严格守恒）。
INSERT INTO usage_counts_v2 (kind,scope,provider,bucket,success,fail)
  SELECT kind,scope,provider,substr(hour,1,14)||'00',success/4,fail/4 FROM usage_counts;
INSERT INTO usage_counts_v2 (kind,scope,provider,bucket,success,fail)
  SELECT kind,scope,provider,substr(hour,1,14)||'15',success/4,fail/4 FROM usage_counts;
INSERT INTO usage_counts_v2 (kind,scope,provider,bucket,success,fail)
  SELECT kind,scope,provider,substr(hour,1,14)||'30',success/4,fail/4 FROM usage_counts;
INSERT INTO usage_counts_v2 (kind,scope,provider,bucket,success,fail)
  SELECT kind,scope,provider,substr(hour,1,14)||'45',
         success - 3*(success/4), fail - 3*(fail/4) FROM usage_counts;

-- 3) 换表（DROP 连同旧表全部索引一并移除）
DROP TABLE usage_counts;
ALTER TABLE usage_counts_v2 RENAME TO usage_counts;

-- 4) 重建 + 新增索引
CREATE INDEX idx_usage_scope  ON usage_counts (kind, scope, bucket, provider);
CREATE INDEX idx_usage_window ON usage_counts (kind, bucket, provider);
CREATE INDEX idx_usage_signal ON usage_counts (kind, bucket, scope, fail);
