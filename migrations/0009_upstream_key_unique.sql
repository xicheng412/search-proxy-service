-- 0009_upstream_key_unique: 上游 key 值在 provider 内唯一。
--
-- 应用层过去只做「先查后插」的软去重，并发提交或同一批输入内重复会落成两行；
-- 同一真实 key 因此可能在 key 池里占两票、翻倍打上游，删除一把后另一把仍有效。
--
-- 前置预检（有结果就人工处理，不要直接跑本迁移）：
--   wrangler d1 execute search-proxy --remote \
--     --file=scripts/preflight-upstream-key-duplicates.sql
-- 预检会返回重复组（provider + count + ids，不输出 key 明文）。确认重复已清理后再 apply；
-- 若仍有重复，CREATE UNIQUE INDEX 会失败并使迁移中止（deploy.sh 不会继续部署）。
CREATE UNIQUE INDEX idx_upstream_keys_provider_key
ON upstream_keys(provider, key);