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

**可用性（availability）**:
一把上游 key 在某一时刻的统一状态，由「人工启停」与「机器冷却」两个来源派生，取值只有三种：**可用**（启用且不在冷却）、**已停用**（人工禁用）、**冷却中**（机器设置的、到期自动解除的停用，携带截止时刻与**冷却因由**）。人工停用优先于冷却；冷却到期即回到可用，无需人工干预。这是"能不能被选"的唯一判据——选 key 只看可用性，不看权重。
_Avoid_: 状态、健康度

**冷却因由（cooldown cause）**:
标记一把 key 为什么处于冷却中：**post-use**（每次使用后的固定短冷却）、**熔断**（连续失败指数退避）、**疑似失效**（鉴权或限流导致的 key 级不可用长冷却）、**限流**（额度耗尽/限流，与疑似失效同机制但独立标注，便于界面区分）。因由只用于解释与展示，冷却时长与是否计数由**重试分类族**决定。
_Avoid_: 错误类型、失败原因

**provider**:
一家上游搜索/数据 API 服务商（公司），本服务代理其若干**能力（capability）**，并以其为路由与统计的维度。当前：Tavily（提供 Search、Extract）、Exa（提供 Search）。新增一个 provider 的常规路径只加一份描述符；少数展示点按 provider 名固化（例外清单以 architecture 的 provider 扩展章节为准，发布新 provider 时须同步）。
_Avoid_: 上游、后端、search engine

**能力（capability）**:
provider 提供的可调用服务，本服务按端点接入。当前代理两项：**Search**（Tavily / Exa 均提供，经本服务 `/search` 端点）与 **Extract**（仅 Tavily 提供，经 `/extract` 与 `/reader/<url>` 端点）。指"调什么功能 / 请求体 / 响应"时必须用能力名（Tavily Search / Exa Search / Tavily Extract），**不**让 provider 名代指能力。能力**原子、扁平**；抽象层独立存在，**执行层必须落地到某 provider 的上游入口（上游 path + 开放的线协议）才可调用**，未落地 = 对使用者不存在；不引入能力依赖能力。
_Avoid_: 服务、功能、endpoint

**端点（endpoint）**:
本服务的 URL 路径（`/search`、`/extract`、`/reader/<url>`），是能力的接入点。provider 由前缀决定、能力由端点决定、包装由线协议决定，三者正交。**能力与端点是不同维度，名字可以相同也可以不同**——`/search`↔Search、`/extract`↔Extract 同名（透传设计）、`/reader`↔Extract 不同名；功能归属一律看"能力 × 端点"映射，**不按名字推导**。每个 provider 记录的是其能力的**上游落地**（上游 path + 开放的线协议）。
_Avoid_: 接口、API、route

**线协议（wire protocol）**:
调用方与本服务之间的通信协议——`native`（原样透传上游协议）、`searxng`（SearXNG 兼容 JSON，需转换）或 `reader`（URL→页面正文文本，需转换）。与 **provider** 正交（工程覆盖可扩展），但**受能力约束**（searxng 仅服务 Search、reader 仅服务 Extract）——协议是能力的延伸/属性，不是与能力平行的维度。
_Avoid_: 协议、transport、protocol

**复合前缀（compound prefix）**:
调用凭据里同时决定线协议与路由 provider 的前缀段 `<proto?-><provider>`（如 `tavily-`、`searxng-tavily-`、`reader-tavily-`；复合前缀大小写不敏感）。（能力由端点决定，不从前缀来。）
_Avoid_: 前缀、key 前缀

### 可靠性概念

**候选 key（candidate）**:
**可用性**为「可用」的上游 key（启用且不在冷却中；冷却已到期的视同可用），可被挑选参与本次请求。
_Avoid_: 可用 key、healthy key

**重试分类族（failure class）**:
上游响应按**故障可归因性**分成四族，决定"换 key / 冷却 / 记账"的归属——所有冷却与统计行为都以本分类为准，**不要按状态码数字手工推导**。族本身与状态码无关；每个 provider 用一张映射表把编号归入某族，未列出的编号落到该 provider 声明的兜底族。处理动作与记账策略矩阵见 architecture 的重试章节：
- `rate-limit`：**key 级不可用**（典型为上游限流/额度耗尽）——记一次失败 + 疑似失效长冷却（默认 12h，可调，因由标注为「限流」），换 key 重试；不碰熔断连续计数。额度耗尽的 key 由此进入长冷却，不再被反复选中打真实请求。
- `client-error`：客户端/计划确定性错误，立即返回；不重试、不记失败、不需冷却——不是 key 的错。
- `auth-error`：key 级鉴权错误，疑似失效长冷却 + 记当日失败；不碰熔断连续计数。
- `server-error`：其余服务端故障、网络故障，以及 **2xx 但响应内容不可用**——记失败 + 熔断指数退避，换 key。注意 **2xx 而内容不可用也算失败**（上游坏了）；两条统计线的 success/fail 都不跟状态码字面走。未列出的任何状态码一律归该 provider 的兜底族（当前 Tavily/Exa 均为 server-error）——保证未知码确定性，不落入 client-error。

当前编号映射（随 provider 而变，权威在 provider 描述符）：Tavily 的 429/432 → rate-limit、400/404/422/433 → client-error、401/403 → auth-error；Exa 无 432/433。
_Avoid_: 状态码、错误类型

**权重（weight）**:
挑选上游 key 时的概率权重 `1/(最近 30min 滑动窗口失败数+1)`——失败越少权重越高，0 失败最高。它是**软负载分布调节**，不是健康判断：只在几把都可用的候选之间决定选谁；「能不能被选」由**可用性**（实时、硬闸门）决定。权重信号基于**滑动时间窗**（默认 30min）——窗口内失败累计，窗口流出即自动回权：成功只归零熔断连续计数，不消窗口内失败；失败数随窗口自然流出而衰减，恢复的 key 不必等跨天、旧失败流出 30min 窗口后权重即回升。**与展示口径刻意分叉**：管理页「当日成功/失败」保持 UTC 日（成功不回填、当日失败当日可见），权重信号用滑动窗口——两套时间基准是有意的，不要混读。
_Avoid_: score、评分、健康度

**冷却（cooldown）**:
**可用性**的一种：某上游 key 在一段时间内不参与挑选（机器设置的、到期自动解除的停用）。分三层：**post-use**（每次使用后固定短时，防止打穿）、**熔断**（连续失败指数退避）、**疑似失效**（鉴权错误与限流/额度耗尽的 key 级不可用固定长冷却）；冷却因由用于区分它们。
_Avoid_: 退避、backoff、冻结

**熔断（circuit breaker）**:
连续失败计数驱动的自动冷却策略：仅**key 级/上游可用性故障**（`server-error`：其余 5xx、网络错误、2xx 但响应内容不可用）使连续失败 +1（10 分钟空窗内），冷却时长指数退避（base × 2^连续失败）。`client-error`、`auth-error` 与 `rate-limit` 均不计——它们要么不是 key 的错、要么已有专属机制。分类归属见**重试分类族**，此处不按状态码数字罗列。
_Avoid_: breaker

**疑似失效冷却（invalid cooldown）**:
key 级不可用（分类族 `auth-error` 与 `rate-limit`）触发的固定长冷却（默认 12h，可调），到期重试一次；限流以独立因由「限流」标注（UI「限流冷却」），鉴权类标注为「疑似失效」。**不碰熔断连续失败计数**，但**记统计失败**——管理页「当日失败」可见；权重惩罚不随成功卸下、只随滑动窗口流出消退（见**权重**）。
_Avoid_: 失效冷却、死 key 冷却

**重试状态机（retry FSM）**:
`searchWithRetry` 的声明式状态机——每次尝试换一个上游 key，响应按分类迁移状态（成功 / 换 key 重试 / 立即返回）。每次"选中并发出上游请求"计一次尝试（含随后被判为重试类的失败）；只有 `client-error` 与成功不进入下一轮。
_Avoid_: retry loop、重试循环

### 领域事件（分解的命令结果）

**UpstreamAttemptSettled**:
一次上游尝试结束（成功 / 按重试分类族归类失败）分解出的领域事件，由重试 FSM 的在飞环节发布，经同步事件轴驱动冷却与记账——订阅者按分类族路由：success 记 success；server-error / auth-error / rate-limit 记 fail（及各自冷却）；client-error 不入此事件（不换 key 不记账）。
_Avoid_: 重试结果、markSuccess / markFail

> 事件轴只服务 UpstreamAttemptSettled：dist 已迁主 Worker 计数（countDist 中间件直记，不经事件总线）。

### 统计概念

**当日（today）**:
用量统计的时间边界，UTC 日 00:00，**管理页/服务端口径**。管理页「当日成功/失败」按此口径；跨天自然归零，无定时任务。**注意**：Dashboard「昨日/今日」卡是 dist 线由前端按**浏览器本地时区**对小时桶归日组合，与「当日」的 UTC 服务端口径不同，勿混读（见**小时桶**「今日/最近 N 小时」由前端组合）。
_Avoid_: 今天、每日

**小时桶（hour bucket）**:
用量聚合的最小单位，UTC 整点时段（`YYYY-MM-DDTHH:00`），upstream / dist 两线共用。"今日 / 最近 N 小时"边界由前端按小时分段自行组合。落库默认 ≥30 分钟一次（显式契约），不追求实时。
_Avoid_: 日桶、time bucket

**upstream 统计（upstream 成本线）**:
按「上游 key 尝试」记账：一次向上游官方 key 的请求尝试记一条，`scope` = 上游 key id。成败按**重试分类族**归属：`server-error`、`auth-error` 与 `rate-limit` 记失败；`client-error` 不计。回答「每把官方 key 被真实调用了几次、成败如何」——成本与健康度。供上游 Keys 页「当日成功/失败」、选 key 权重信号消费。**与 dist 统计是不同维度，不要求一致。** 当前不单列成本；`attempt` 口径 = **计入 success/fail 的发送次数**（即 `calls = success + fail` 的加数）：`rate-limit` 与 `server-error` / `auth-error` 一样计入 fail，`client-error` 不产生 attempt（直接返回不重试）。真实发出但未记统计的发送（中途中止等）单列，不入 `calls`。
_Avoid_: 上游调用统计、接口统计

**dist 统计（dist 消费线）**:
按「分发 key 请求**到达量**」记账的消费线：每笔通过鉴权的数据面请求在**主 Worker** 于转发前 +1，不区分成败、不耦合上游执行（重试/熔断发生在队列侧，dist 只有这一笔）。只记到达、不记成败：计数槽恒为 success（无 fail 维度；`calls = success + fail` 派生不变）。队列拒入（429）与客户端断连发生在请求转发之后——请求确已到达 → **计入**；鉴权失败（401）在准入阶段短路 → 不计。**不要把 dist 的计数读成请求结果成败——上游真实成败见 upstream 线。** 不区分后端/协议、不带 provider 维度，`scope` = 分发 key。消费方只取 `calls` 总量（逐 key「最近24h请求」、Dashboard「最近24小时/昨日」卡）。**与 upstream 统计是不同维度，不要求一致。**
_Avoid_: 调用统计、请求统计

**统计选数（stat source）**:
用哪条统计线先定问题：问官方 key 的消耗/健康 → `upstream`；问分发 key 的用量/账单 → `dist`。两线记账粒度和分类不同——一次请求可放大成多条 upstream 记录（重试）、只一条 dist 记录；dist 记「**请求到达量**」（主 Worker +1，不经事件轴、不耦合上游执行）；队列拒入 429 计入（请求确已到达）、鉴权失败 401 不计。**不要拿它们对账。** dist 只到次数粒度、不含后端维度；后端真实调用见 upstream 统计。
_Avoid_: 直接对比 upstream/dist 数字

**写回式近似统计（write-back approximate stats）**:
用量先在 isolate 内存累积、节流 flush 落库的近似统计：写失败静默、读失败按 0，绝不阻塞主流程。精确度是显式、可消费的设计变量。契约：单 isolate 缓冲共用；落库双阈值 **≥30min 或 ≥256 条**；队列清空时兜底 flush 防止悬空；isolate 被回收时未 flush 增量丢失 ≤ 阈值区间。权重信号底数**独立于 flush 刷新**（默认封顶 120s），**不与 flush 同节奏**。**内存优先边界**：熔断 / 冷却判据强一致，权威态在持有该 key 池的单进程内存（per-provider 队列实例；D1 为 ≤30s 低频 checkpoint，丢失方向安全）；鉴权判据仍走读穿缓存。近似只影响展示与权重信号，不影响任何硬闸门。
_Avoid_: 精确统计、real-time stats

**队列任务（queue task）**:
主 Worker 鉴权后把"一次相对上游的请求"打装成的可序列化任务。一个任务 = 一次对上游的**完整处理**（内部重试最多换 3 把 key，重试永远不入队），经所属 provider 的队列串行放行：一次只在途 1 个任务，任务结束后隔 `intervalMs`（默认 3s，运行时可调）再放下一个——`intervalMs` 是**任务间最小间隔**，真实放行率 = 1 / max(任务耗时, intervalMs)。排队请求**持连接等待自己的时间片**，等待时延 ≈ 排在前面所有任务的耗时之和；排队数达 `maxDepth`（默认 10）时新请求直接 429 拒入（不计 upstream 执行、但计入 dist 请求到达数），入队后等待超过 `waitBudgetMs`（默认 30s，运行时可调）也直接 429 + Retry-After（与拒入同语义、不计 upstream 执行、但计入 dist 请求到达数）——`maxDepth` 与 `waitBudgetMs` 构成「深度 + 时间」两种背压；客户端断开未轮到则丢弃（不烧上游配额；dist 请求到达已在主 Worker 计入）。
_Avoid_: job、请求任务
