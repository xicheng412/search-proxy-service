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
用量统计的时间边界，UTC 日 00:00（`utcTodayStart()`），upstream / dist 两线共用。管理页「当日成功/失败」按此口径；跨天自然归零，无定时任务。
_Avoid_: 今天、每日

**小时桶（hour bucket）**:
用量聚合的最小单位，UTC 整点时段 `YYYY-MM-DDTHH:00`，upstream / dist 两线共用。"今日 / 最近 N 小时"边界由前端按小时分段自行组合。
_Avoid_: 日桶、time bucket

**upstream 统计（upstream stats, `kind='upstream'`）**:
按「上游 key 尝试」记账：一次向上游官方 key 的请求尝试记一条（成功/失败按响应分类；429 与 400/404/422 不记），`scope` = 上游 key id。回答「每把官方 key 被真实调用了几次、成败如何」——成本与健康度。供 Tavily/Exa Keys 页「当日成功/失败」、选 key 权重信号消费。**与 dist 统计是不同维度，不要求一致。**
_Avoid_: 上游调用统计、接口统计

**dist 统计（dist stats, `kind='dist'`）**:
按「分发 key 请求计数」记账：success/fail 二元，每单一条——进入重试核即记成功（503 亦算），searxng 参数错误记 fail，队列拒入（429）不计；不区分后端/协议（provider 列写哨兵 `'*'`），`scope` = 分发 api_key。回答「每个分发 key 发出多少请求」——消费方用量。用途：分发 Keys 页「最近24h调用」（逐 key）、Dashboard「最近24小时/昨日」卡（跨全部分发 key 汇总）。**与 upstream 统计是不同维度，不要求一致。**
_Avoid_: 调用统计、请求统计

**统计选数（stat source）**:
用哪条统计线先定问题：问官方 key 的消耗/健康 → `upstream`；问分发 key 的用量/账单 → `dist`。两线记账粒度和分类不同——一次请求可放大成多条 upstream 记录（重试）、只一条 dist 记录；503 也记 dist 成功；鉴权失败的请求两线都不记。**不要拿它们对账。** dist 只到次数粒度，不含后端维度；后端真实调用见 upstream 统计。
_Avoid_: 直接对比 upstream/dist 数字

**写回式近似统计（write-back approximate stats）**:
用量先在 isolate 内存累积、节流 flush 落库的近似统计：写失败静默、读失败按 0，绝不阻塞主流程。精确度是显式、可消费的设计变量。
_Avoid_: 精确统计、real-time stats

**队列任务（queue task）**:
主 Worker 鉴权后把"一次相对上游的请求"打装成的可序列化任务（`NativeTask` / `SearxngTask`），转发给所属 provider 的队列 DO 串行放行。
_Avoid_: job、请求任务
