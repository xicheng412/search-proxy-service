# Search Proxy Service

一个部署在 Cloudflare Workers 上的搜索 API 密钥代理：持有上游搜索服务（provider）的真实 key，向外签发可独立管控、可熔断的高熵 key，并统一线协议、重试与熔断策略。`docs/architecture.md` 描述实现，本文件描述领域词。

## Language

### 核心实物流

**上游 key（upstream key）**:
本服务持有的某个 provider 的真实 API 凭据（Tavily `tvly-…` / Exa 不规则串），列表一律脱敏展示。
_Avoid_: 真实 key、provider key、外部 key

**分发 key（distributed key）**:
签发给调用方的高熵随机字符串（hex，无品牌前缀），调用时以 `Bearer <复合前缀>-<key>` 携带。分发 key 自身**不带** provider 属性。
_Avoid_: API key、访问 key、客户端 key

**provider**:
一个上游搜索服务（当前为 Tavily / Exa），是路由与统计的维度。新增一个 provider 只加一份描述符。
_Avoid_: 上游、后端、search engine

**线协议（wire protocol）**:
调用方与本服务之间的通信协议——`native`（原样透传上游协议）或 `searxng`（SearXNG 兼容 JSON，需转换）。与 provider **正交**。
_Avoid_: 协议、transport、protocol

**复合前缀（compound prefix）**:
调用凭据里同时决定线协议与路由 provider 的前缀段 `<proto?-><provider>`（如 `tavily-`、`searxng-tavily-`；复合前缀大小写不敏感）。
_Avoid_: 前缀、key 前缀

### 可靠性概念

**候选 key（candidate）**:
状态为 `enabled` 且已过冷却截止时间（`cooldown_until`），可被挑选参与本次请求的上游 key。
_Avoid_: 可用 key、healthy key

**权重（weight）**:
挑选上游 key 时的概率权重 `1/(当日失败数+1)`——失败越少权重越高，0 失败最高。
_Avoid_: score、评分

**冷却（cooldown）**:
某上游 key 在一段时间内不参与挑选的状态（以 `cooldown_until` 表达）。分三层：**post-use**（每次使用后固定短时，防止打穿）、**熔断**（连续失败指数退避）、**疑似失效**（401/403 固定长冷却）。
_Avoid_: 退避、backoff、冻结

**熔断（circuit breaker）**:
连续失败计数驱动的自动冷却策略：非 429 失败使连续失败计数 +1（10 分钟空窗内），冷却时长指数退避。
_Avoid_: breaker

**疑似失效冷却（invalid cooldown）**:
401/403（key 级鉴权错误）触发的固定长冷却（默认 12h），到期重试一次；不碰连续失败计数。
_Avoid_: 失效冷却、死 key 冷却

**重试状态机（retry FSM）**:
`searchWithRetry` 的声明式状态机——每次尝试换一个上游 key，响应按分类迁移状态（成功 / 换 key 重试 / 立即返回）。
_Avoid_: retry loop、重试循环

### 统计概念

**当日（today）**:
Asia/Shanghai 时区的 `YYYY-MM-DD` 日期（`todayDate()`）。用量跨天自然归零，无定时任务。
_Avoid_: 今天、每日

**小时桶（hour bucket）**:
用量聚合的最小单位，UTC 整点时段 `YYYY-MM-DDTHH:00`。"今日 / 最近 N 小时"边界由前端按小时分段自行组合。
_Avoid_: 日桶、time bucket

**写回式近似统计（write-back approximate stats）**:
用量先在 isolate 内存累积、节流 flush 落库的近似统计：写失败静默、读失败按 0，绝不阻塞主流程。精确度是显式、可消费的设计变量。
_Avoid_: 精确统计、real-time stats

**队列任务（queue task）**:
主 Worker 鉴权后把"一次相对上游的请求"打装成的可序列化任务（`NativeTask` / `SearxngTask`），转发给所属 provider 的队列 DO 串行放行。
_Avoid_: job、请求任务
