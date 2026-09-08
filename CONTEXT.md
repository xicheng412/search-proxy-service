# Search Proxy Service

一个部署在 Cloudflare Workers 上的搜索 API 密钥代理：持有上游搜索服务（provider）的真实 key，向外签发可独立管控、可熔断的高熵 key，并统一线协议、重试与熔断策略。`docs/architecture.md` 描述实现，本文件描述领域词。

## Language

### 核心实物流

**上游 key（upstream key）**:
本服务持有的某个 provider 的真实 API 凭据（Tavily `tvly-…` / Exa 不规则串），列表一律脱敏展示。
_Avoid_: 真实 key、provider key、外部 key

**分发 key（distributed key）**:
签发给调用方的高熵随机字符串（hex，无品牌前缀），调用时以 `Bearer <复合前缀>-<key>` 携带。分发 key 自身**不带** provider 属性：路由 provider 与线协议由**调用方在请求时自选前缀**决定，签发时不锁定。因此**一把 key 等价解锁全部 provider/协议链路**——可管控的维度只有启用/禁用/删除，无法签发"仅限某 provider / 某协议"的 key；一把 key 泄露 = 全部链路全开。这是主动选型（key 无状态，路由交给调用方），代价是授权粒度与分 provider 统计的缺失。
_Avoid_: API key、访问 key、客户端 key

**provider**:
一家上游搜索/数据 API 服务商（公司），本服务代理其若干**能力（capability）**，并以其为路由与统计的维度。当前：Tavily（提供 Search、Extract）、Exa（提供 Search）。新增一个 provider 只加一份描述符。
_Avoid_: 上游、后端、search engine

**能力（capability）**:
provider 提供的可调用服务，本服务按端点接入。当前代理两项：**Search**（Tavily / Exa 均提供，经本服务 `/search` 端点）与 **Extract**（仅 Tavily 提供，经 `/extract` 与 `/reader/<url>` 端点）。指"调什么功能 / 请求体 / 响应"时必须用能力名（Tavily Search / Exa Search / Tavily Extract），**不**让 provider 名代指能力（端点与能力映射见 architecture §2.3）。能力**原子、扁平**；抽象层独立存在，**执行层必须落地到某 provider 的 `Surface`（path + 开放协议）才可调用**，未落地 = 对使用者不存在；不引入能力依赖能力。
_Avoid_: 服务、功能、endpoint

**端点（endpoint）**:
本服务的 URL 路径（`/search`、`/extract`、`/reader/<url>`），是能力的接入点。provider 由前缀决定、能力由端点决定、包装由线协议决定，三者正交。**能力与端点是不同维度，名字可以相同也可以不同**——`/search`↔Search、`/extract`↔Extract 同名（透传设计）、`/reader`↔Extract 不同名；功能归属一律看"能力 × 端点"映射，**不按名字推导**。代码里 `ProviderConfig.capabilities` 记录的是每个能力的**上游落地**（Surface = 上游 path + 开放的线协议）。
_Avoid_: 接口、API、route

**线协议（wire protocol）**:
调用方与本服务之间的通信协议——`native`（原样透传上游协议）、`searxng`（SearXNG 兼容 JSON，需转换）或 `reader`（URL→页面正文文本，需转换）。与 **provider** 正交（工程覆盖可扩展），但**受能力约束**（searxng 仅服务 Search、reader 仅服务 Extract）——协议是能力的延伸/属性，不是与能力平行的维度。
_Avoid_: 协议、transport、protocol

**复合前缀（compound prefix）**:
调用凭据里同时决定线协议与路由 provider 的前缀段 `<proto?-><provider>`（如 `tavily-`、`searxng-tavily-`、`reader-tavily-`；复合前缀大小写不敏感）。（能力由端点决定，不从前缀来。）
_Avoid_: 前缀、key 前缀

### 可靠性概念

**候选 key（candidate）**:
状态为 `enabled` 且已过冷却截止时间（`cooldown_until`），可被挑选参与本次请求的上游 key。
_Avoid_: 可用 key、healthy key

**重试分类族（failure class）**:
上游响应按**故障可归因性**分成四族，决定"换 key / 冷却 / 记账"的归属——所有冷却与统计行为都以本分类为准，**不要按状态码数字手工推导**。族枚举 = `domain.ts` 的 `RetryClass`；编号→族映射在 provider 描述符（`statusClassMap` + 兜底 `statusClassFallback`）；处理动作与记账策略矩阵见 architecture §6.3：
- `rate-limit`（429/432）：仅 post-use 冷却，换 key 重试；不记失败、不熔断。
- `client-error`（400/404/422/433）：客户端/计划确定性错误，立即返回；不重试、不记失败、不需冷却——不是 key 的错。
- `auth-error`（401/403）：key 级鉴权错误，疑似失效长冷却 + 记当日失败；不碰熔断连续计数。
- `server-error`（其余 5xx / 网络 / **2xx 但响应内容不可用**）：记失败 + 熔断指数退避，换 key。注意 **2xx 而内容不可用也算失败**（上游坏了），与 dist 线"503 也算成功"互为镜像——两条线的 success/fail 都不跟状态码字面走。
_Avoid_: 状态码、错误类型

**权重（weight）**:
挑选上游 key 时的概率权重 `1/(最近 30min 滑动窗口失败数+1)`——失败越少权重越高，0 失败最高。它是**软负载分布调节**，不是健康判断：只在几把都健康的候选之间决定选谁；「能不能被选」由冷却（实时、硬闸门）决定。权重信号基于**滑动时间窗**（默认 30min，`usage_store.ts` 的 `weightWindowMs`；陈旧快照 + 本实例增量，热路径 0 次 D1 往返）——窗口内失败累计，窗口流出即自动回权：成功只归零熔断连续计数，不消窗口内失败；失败数随窗口自然流出而衰减，恢复的 key 不必等跨天、旧失败流出 30min 窗口后权重即回升。**与展示口径刻意分叉**：管理页「当日成功/失败」保持 UTC 日（成功不回填、当日失败当日可见），权重信号用滑动窗口——两套时间基准是有意的，不要混读。
_Avoid_: score、评分、健康度

**冷却（cooldown）**:
某上游 key 在一段时间内不参与挑选的状态（以 `cooldown_until` 表达）。分三层：**post-use**（每次使用后固定短时，防止打穿）、**熔断**（连续失败指数退避）、**疑似失效**（401/403 固定长冷却）。
_Avoid_: 退避、backoff、冻结

**熔断（circuit breaker）**:
连续失败计数驱动的自动冷却策略：仅**key 级/上游可用性故障**（`server-error`：5xx、网络错误、2xx 但响应内容不可用）使连续失败 +1（10 分钟空窗内），冷却时长指数退避（base × 2^连续失败）。`client-error`、`auth-error` 与 `rate-limit` 均不计——它们要么不是 key 的错、要么已有专属机制。分类归属见**重试分类族**，此处不按状态码数字罗列。
_Avoid_: breaker

**疑似失效冷却（invalid cooldown）**:
401/403（key 级鉴权错误，分类族 `auth-error`）触发的固定长冷却（默认 12h），到期重试一次。**不碰熔断连续失败计数**，但**记统计失败**——管理页「当日失败」可见；权重惩罚不随成功卸下、只随滑动窗口流出消退（见**权重**）。
_Avoid_: 失效冷却、死 key 冷却

**重试状态机（retry FSM）**:
`searchWithRetry` 的声明式状态机——每次尝试换一个上游 key，响应按分类迁移状态（成功 / 换 key 重试 / 立即返回）。
_Avoid_: retry loop、重试循环

### 统计概念

**当日（today）**:
用量统计的时间边界，UTC 日 00:00（`utcTodayStart()`），upstream / dist 两线共用。管理页「当日成功/失败」按此口径；跨天自然归零，无定时任务。
_Avoid_: 今天、每日

**小时桶（hour bucket）**:
用量聚合的最小单位，UTC 整点时段 `YYYY-MM-DDTHH:00`，upstream / dist 两线共用。"今日 / 最近 N 小时"边界由前端按小时分段自行组合。落库默认 ≥30 分钟，显式契约（`usage-store.flushIntervalMs`），不追求实时。
_Avoid_: 日桶、time bucket

**upstream 统计（upstream stats, `kind='upstream'`）**:
按「上游 key 尝试」记账：一次向上游官方 key 的请求尝试记一条，`scope` = 上游 key id。成败按**重试分类族**归属：`server-error`（5xx/网络/2xx-不可用）与 `auth-error`（401/403）记失败；`rate-limit`（429/432）与 `client-error`（400/404/422/433）不计。回答「每把官方 key 被真实调用了几次、成败如何」——成本与健康度。供 Tavily/Exa Keys 页「当日成功/失败」、选 key 权重信号消费。**与 dist 统计是不同维度，不要求一致。** 429/432（`rate-limit`）不计成功/失败、当前不单列成本；`attempt` 口径 = **非 rate-limit 的"一次尝试"**——即每次真实发送给上游的请求，但限流不计入成败，避免"真实调用次数"与实现背离。
_Avoid_: 上游调用统计、接口统计

**dist 统计（dist stats, `kind='dist'`）**:
按「分发 key 请求**受理量**」记账的消费线：每单一条、success/fail 二元。**`success` 的语义是「受理」——请求被本服务受理、进入重试核即记 success，与上游成败无关**（最终 503/502 亦算 success；重试放大只出现在 upstream 线，dist 恒一单一条）；`fail` 仅指「受理后因调用方过错被拒」（searxng 参数错误）；未受理不计（鉴权失败、队列拒入 429、连接断开）。**不要把 dist 的 success/fail 读成请求结果成败——上游真实成败见 upstream 线。** 不区分后端/协议（provider 列写哨兵 `'*'`），`scope` = 分发 api_key。消费方只取 `calls = success + fail` 总量（逐 key「最近24h调用」、Dashboard「最近24小时/昨日」卡）。**与 upstream 统计是不同维度，不要求一致。**
_Avoid_: 调用统计、请求统计

**统计选数（stat source）**:
用哪条统计线先定问题：问官方 key 的消耗/健康 → `upstream`；问分发 key 的用量/账单 → `dist`。两线记账粒度和分类不同——一次请求可放大成多条 upstream 记录（重试）、只一条 dist 记录；dist 记「**受理**」而非结果成败（最终 503/502 亦算 success）；鉴权失败与队列拒入（429）的请求两线都不记。**不要拿它们对账。** dist 只到次数粒度、不含后端维度；后端真实调用见 upstream 统计。
_Avoid_: 直接对比 upstream/dist 数字

**写回式近似统计（write-back approximate stats）**:
用量先在 isolate 内存累积、节流 flush 落库的近似统计：写失败静默、读失败按 0，绝不阻塞主流程。精确度是显式、可消费的设计变量。契约：单 isolate 缓冲（pending）共用；落库双阈值 **≥30min 或 ≥256 条**（`usage-store.flushIntervalMs` / `flushMaxPending`）；队列清空时兜底 flush（见 queue DO）防止悬空；isolate 被回收时未 flush 增量丢失 ≤ 阈值区间。权重信号 base **独立 120s 刷新**（queue drain 驱动，`signalBaseTtlMs`），**不与 flush 同节奏**。**内存优先边界**：熔断 / 冷却 / 鉴权判据是强一致持久（D1/KV 实时读写），**不进近似统计范围**——近似只影响展示与权重信号，不影响任何硬闸门。
_Avoid_: 精确统计、real-time stats

**队列任务（queue task）**:
主 Worker 鉴权后把"一次相对上游的请求"打装成的可序列化任务（`NativeTask` / `SearxngTask` / `ReaderTask`）。一个任务 = 一次对上游的**完整处理**（内部重试最多换 3 把 key，重试永远不入队），经所属 provider 的队列 DO 串行放行：一次只在途 1 个任务，任务结束后隔 `intervalMs`（默认 3s，`queue_config` 运行时可调）再放下一个——`intervalMs` 是**任务间最小间隔**，真实放行率 = 1 / max(任务耗时, intervalMs)。排队请求**持连接等待自己的时间片**，等待时延 ≈ 排在前面所有任务的耗时之和；排队数达 `maxDepth`（默认 10）时新请求直接 429 拒入（不计统计），入队后等待超过 `waitBudgetMs`（默认 30s，`queue_config` 运行时可调）也直接 429 + Retry-After（与拒入同语义、不计统计）——`maxDepth` 与 `waitBudgetMs` 构成「深度 + 时间」两种背压；客户端断开未轮到则丢弃（不烧上游配额）。
_Avoid_: job、请求任务
