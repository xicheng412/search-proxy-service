# 领域概念（命令 → 事件 → 聚合/实体 → 领域服务）

> 本文件是 DDD 划界的参考词典：命令由谁触发、落到哪个聚合/服务、
> 产出什么领域事件、订阅者是谁。代码分层见 docs/architecture.md §4；
> 领域词汇的准确术语以 CONTEXT.md 为准，本文件只引用不重复词条。
>
> **限界上下文**：单上下文（CONTEXT.md / docs/agents/domain.md），无跨上下文防腐层。
> 事件轴只剩 **UpstreamAttemptSettled**（QueueDO 的 `ensureBus` 在自身 isolate 注册一次，幂等）；
> dist 改为主 Worker `countDist` 中间件直接记（请求到达量），不产生领域事件。事件只在同 isolate
> 内同步分发，不跨 isolate、不入队列。

## 1. 命令盘点（用户/系统触发）

命令 = 一次有明确意图的触发（用户操作 / 调用方请求 / 系统 scheduled 事件）。
现状处理入口经 `grep -n "POST /\|:id/\|:apiKey/" src/admin` + 路由装配核对。

| 命令 | 触发者 | 现状处理入口 |
|---|---|---|
| GenerateDistributedKey | 用户(admin) | keysAdmin POST /admin/keys/generate → storage.generateDistributedKey |
| ToggleDistributedKey | 用户(admin) | POST /admin/keys/:apiKey/toggle → updateDistributedKey |
| DeleteDistributedKey | 用户(admin) | POST /admin/keys/:apiKey/delete → deleteDistributedKey |
| AddUpstreamKey(+test) | 用户(admin) | POST /admin/{tavily\|exa}/add → addUpstreamKey + notifyKeyPoolSync |
| AddUpstreamKeysBatch | 用户(admin) | POST /admin/{tavily\|exa}/add/batch → addUpstreamKeysBatch（单次批量写） + notifyKeyPoolSync |
| RenameUpstreamKey | 用户(admin) | POST /admin/{tavily\|exa}/:id/name → updateUpstreamKey + notifyKeyPoolSync |
| ToggleUpstreamKey | 用户(admin) | POST /admin/{tavily\|exa}/:id/toggle → updateUpstreamKey + notifyKeyPoolSync |
| ToggleUpstreamKeysBatch | 用户(admin) | POST /admin/{tavily\|exa}/batch-toggle → toggleUpstreamKeysBatch（单条 UPDATE）+ activate/notifyKeyPoolSync |
| DeleteUpstreamKey | 用户(admin) | POST /admin/{tavily\|exa}/:id/delete → deleteUpstreamKey + notifyKeyPoolSync |
| DeleteUpstreamKeysBatch | 用户(admin) | POST /admin/{tavily\|exa}/batch-delete → deleteUpstreamKeysBatch（单条 DELETE）+ notifyKeyPoolSync |
| UpdateQueueConfig / UpdateBreakerConfig / UpdateDistCacheConfig | 用户(admin) | admin POST /admin/queue-config / breaker-config / dist-cache-config → KV 写 + 缓存失效 |
| AuthenticateRequest | 调用方 | authenticate middleware → getDistributedKey（含复合前缀解析 + Cache API 读穿） |
| ExecuteProxyRequest（search/extract/reader → QueueDO） | 调用方 | handlers → countDist（dist 到达计数在主 Worker 转发前完成）→ forwardToQueue → QueueDO → executor → searchWithRetry |
| ScheduledPurgeUsage | cron（scheduled 事件） | index.ts scheduled → DELETE FROM usage_counts WHERE bucket < cutoff |

## 2. 领域事件（命令产物）

type 判定由订阅者 switch，勿建事件层级；事件类型定义在 `domain.ts`。

| 事件 | 产生者 | 订阅者 | 是否进 D1 |
|---|---|---|---|
| UpstreamAttemptSettled | retry FSM 在飞环节（searchWithRetry 迁移 action） | QueueDO 专属订阅：按 cls 路由冷却（recordUpstreamOutcome 写 KeyPool 内存）+ usage 记账（recordUpstreamResult 内存 pending） | 冷却经 checkpoint 低频落库；usage 经 flush 节流落库 |

> `UpstreamKeyChanged` 只是语义标签，**不是**代码中的事件类型（无对应 symbol）：admin 的 14 处写命令（`tavily.ts` / `exa.ts` 各 7）在 D1 落库后调用 `notifyKeyPoolSync` → `/_internal/sync-keys` → `KeyPool.reload`。本文件 §2/§3 保留该名字仅用于描述"写后同步内存池"的意图。

## 3. 命令 × 事件追溯

命令 → 事件产物 → 订阅者落点，两张方向的查表（与 §1/§2 互证）。

| 命令 | 产物事件 | 订阅者最终落点 |
|---|---|---|
| ExecuteProxyRequest | dist = 主 Worker 直达 +1（非事件）；每尝试 ≤1 × UpstreamAttemptSettled（client-error 不产） | usage_counts（dist 到达量）+ KeyPool 冷却 + usage_counts（upstream 按 cls） |
| Generate/Toggle/DeleteDistributedKey | 无 | 纯 D1 写（+ Cache 失效） |
| Add/Rename/Toggle/DeleteUpstreamKey（含批量） | 语义标签 UpstreamKeyChanged（无事件类型） | notifyKeyPoolSync → KeyPool.reload 全量重读合并 |
| Update*Config | 无 | 纯 KV 写 + TTL 缓存失效 |
| ScheduledPurgeUsage | 无 | 纯 D1 DELETE |

## 4. 领域不变量与业务规则

跨模块领域规则；每条语义见 CONTEXT 对应词目，此处只列简式。

- **dist 单条**：每次调用恰记一条 dist（请求到达量，主 Worker `countDist` 转发前 +1，非事件）；
  与请求最终结果成败无关（队列 429 / 断连均计入）。
- **attempt 口径**：每"选中并发出一次上游请求"计一次（含 rate-limit / auth-error / server-error 后换 key 的重试），
  受 `MAX_ATTEMPTS` 上限约束；只有 `client-error`（确定性 4xx）与 success 不进入下一轮。
  统计口径（`calls = success + fail`）只计入 success/fail 的发送——`client-error` 不产生记录。
- **冷却分层**：post-use / 熔断（指数退避 + 10min 空窗复位）/ 疑似失效三层共用 `cooldown_until`；
  server-error 才驱动连续计数，auth / rate-limit 不碰。
- **选 key 硬闸门**：`enabled ∧ 未冷却` 才入候选；权重 1/(fail+1) 只调分布不判健康。
- **内存权威 + D1 投影**：冷却/熔断写 KeyPool 内存，D1 低频 checkpoint；丢失方向安全（放宽非锁死）。
- **队列背压**：一次在途 1 任务；maxDepth 拒入 / waitBudget 超时双路 429，不计 upstream 执行；
  dist 请求到达已在主 Worker 计入。
- **单点写者**：per-provider KeyPool 仅其 QueueDO 写冷却（权威在内存）；
  D1 只承载投影 / checkpoint 备份 / usage_counts，不参与冷却决策。
- **usage_counts 全 15 分钟桶**：`usage_counts` 全部行为 15 分钟桶；迁移 0007 已把历史小时行按等比
  拆为 4 个桶（余数归最后一段），总量严格守恒。读取侧不区分历史与新增行。

## 5. 聚合与实体

- **聚合 UpstreamKey**：一致性边界 = 某 provider 的全部上游 key 及其可用性状态。实体 CoreKey（身份 `id`）；
  可用性状态（冷却 / 冷却因由 / 熔断连续计数）由该 provider 的**可用性状态持有者**（`src/key-pool.ts` 的 KeyPool，
  应用层对象，非 domain 类型）在单点进程内维护。不变式：仅"可用性 = 可用"的 key 入候选（见 §4）；
  三层冷却共用同一截止时刻字段；熔断连续计数仅存内存。D1 为投影（name/status 权威、冷却备份；ADR-0001）。
- **聚合 DistributedKey（根 = DistributedKey 行）**：实体 DistributedKey（身份 `api_key`）；
  行为 generate / toggle / delete / validateCredential（authenticate）；Cache API 读穿快路径。
- **值对象（domain 层，`src/domain.ts`）**：Availability（可用性）、CooldownCause（冷却因由）、
  RetryClass（重试分类族）、DistAuth（复合前缀解析结果）、bucketKey（时间桶键，以字符串表示）、
  UpstreamAttemptSettled（领域事件）。
- **值对象/DTO（domain 层之外，按所在层归位）**：
  `BreakerState` / `BreakerOutcome` → `src/domain-services/breaker-policy.ts`（领域服务侧值对象）；
  `Surface` / `ProviderConfig` → `src/providers/index.ts`（provider 参考数据）；
  `QueueTask`（`NativeTask` / `SearxngTask` / `ReaderTask`）→ `src/queue/task.ts`（队列 DTO）；
  `AuthContext` → `src/types.ts`（Hono 上下文变量，内嵌 domain 的 DistAuth）。

## 6. 领域服务

| 服务 | 职责 | 消费方 | 文件 |
|---|---|---|---|
| RetryStateMachine | 重试 FSM（searchWithRetry：状态机核，端口化传输与事件） | executors（native/searxng/reader，经 QueueDO.drain） | src/domain-services/retry-state-machine.ts |
| KeySelection | 加权候选选择 | RetryStateMachine.emit | src/domain-services/selection.ts |
| ClassifyService | status→RetryClass | RetryStateMachine.emit | src/domain-services/classify.ts |
| BreakerPolicy | 三层冷却纯策略（computeBreakerOutcome） | circuit-breaker 副作用绑定 | src/domain-services/breaker-policy.ts |
| UpstreamTransport（端口） | 上游 fetch（30s 超时） | QueueDO.drain（注入 CoreDeps.transport） | src/transport.ts |
| 事件分发（基础设施） | 同步轻量分发器 + getEventBus 单例组合根（仅服务 UpstreamAttemptSettled，QueueDO 侧注册一次） | RetryStateMachine → UpstreamAttemptSettled → QueueDO 订阅 | src/events.ts |

## 7. 端口与仓储（基础设施边界）

领域侧只依赖端口接口（依赖倒置，见 architecture §4）；实现由组合根注入。

| 领域依赖端口 | 领域侧引用 | 基础设施实现 |
|---|---|---|
| DomainEventSink | CoreDeps.events | src/events.ts（同步分发器 + per-isolate 单例） |
| UpstreamTransport（typeof upstreamFetch） | CoreDeps.transport | src/transport.ts |
| UsageStore | CoreDeps.usage（统计写 / 权重信号读） | src/usage/（pending 缓冲 + flush + reads） |
| KeyPool | CoreDeps.pool / RetryContext | src/key-pool.ts（内存权威 + checkpoint） |
| storage（UpstreamKey / DistKey / usage_counts） | admin、authenticate、usage | src/storage/（D1） |

仓储说明：UpstreamKey 的仓储 = KeyPool（内存权威，每 provider 一把）+ D1 投影；
DistributedKey 仓储 = D1 直读 + Cache API 读穿。

## 8. 查询侧（读用例，不产事件）

admin 统计（当日 / dashboard 序列）、权重信号均直读 UsageStore/storage，不经命令、
不产领域事件；读坐标系独立于 §1 命令集（CQRS-lite，命令/事件模型只描述写面）。

## 9. 特意不做（成本裁决）

quota / 明细流水 / 跨 isolate 强一致统计 / 异常事件桶（诊断归因留未来）——理由见 docs/architecture.md §5.2 与 ADR-0001。
