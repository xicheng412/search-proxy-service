# 热路径设计指南：把"每次请求都会发生的读"做到 0 往返

> **Status**: accepted（仓库首个 ADR；本篇讲设计思路本身，贯穿示例 = 选 key 权重信号化，涉及 `src/usage-store.ts`、`src/proxy.ts`、`src/storage.ts`）

## 它回答什么问题

当一个功能需要读数据，而这次读会落在**每次调用必走的路径**（热路径）上时，怎么设计，才不会把"读放大"变成"延迟 × QPS"。本文回答三件事：**该想什么**、**设计出来长什么样**、**做了什么取舍**。选 key 权重信号化只作为贯穿示例讲"怎么做到的"，不是记录"这次做了什么"。

## 0. 第一步：先识别热路径

- 热路径 = 每次被调用都执行的路径。沿着请求链路逐行标出读/写，凡"**每次必走 + 远程 IO**（D1/KV/fetch）"即热路径读。
- 示例识别法：`searchWithRetry` 每次请求都经 `readUpstreamTodayStats` 读一次 D1 聚合 `SUM(fail) GROUP BY scope`——而它只是为了给选 key 权重一个当日失败数。
- 成本 = 往返延迟 × QPS。判断这笔读值不值：它换来的语义（这个例子里只是一个只用 fail 的权重）重不重要。

## 1. 第一问：这个读数能不能近似？

- 看**消费者**与**误差方向**。
- **可近似**：统计、权重、展示计数。误差方向甚至有益——`1/(fail+1)` 权重小幅失真只是让负载更均衡，权重本就该贴近"最近大盘"而非"本瞬间"。
- **近似禁区**（`docs/architecture.md §5.1.1`）：安全放行决策——熔断/冷却状态（`breaker_state`、`cooldown_until`）、鉴权与 key 状态。任一优化不得削它们，不许一秒误差。
- 结论先行：数值越不重要、误差越无害，越值得往下做。

## 2. 第二问（核心分叉）：这份数据是谁产的？

缓存/信号的载体由**"数据生产者 vs 消费方"关系**决定，不由"想省多少"决定：

| 数据谁产的 | 手法 | 仓库实例 |
|---|---|---|
| **本 isolate 自己写的**（如统计 flush） | 写路径顺带刷新快照 + 本实例 pending 叠加 → **0 往返** | 选 key 权重信号（`signalBase` + `readUpstreamWeightSignal`） |
| **外部/他处写的**（如 key 仓库） | TTL 读缓存 + 写路径主动失效 | 分发 key 鉴权（Cache API + `cacheTtlSec`，写时 delete） |
| 恒定值 | 解析一次缓存终身 | `resolvePublicBaseUrl` |
| 运行时参数 | 模块级短 TTL（3s）+ 写后 `invalidate()` | `cachedBreakerConfig` / `cachedQueueConfig` / `cachedDistCacheConfig` |

- 判断逻辑：自己写的 → 我掌握写入时机，把刷新挂在写路径上（后台 `waitUntil`，不阻塞请求），读侧就**永不需要碰 IO**；别人写的 → 我只能挂读侧 TTL，靠写方或写路径失效保一致性。

## 3. 第三问：陈旧度边界定多少？

- 陈旧度 = 可接受的语义损失。给**封顶（TTL）**即可，实际新鲜度会更好——有流量时写路径每 ~5s 触发一次，顺带把快照拉到 ~5s 内。封顶是"最坏承诺"，不是常态。
- **冷启动行为必须显式声明**：冷 isolate 首次 base 为空 → 均匀权重（不做错，只是不精），首个 flush 收敛。这是设计的一部分，不是缺陷。

## 4. 最终形态：一套通用模板

把一次热路径读重构成四件套：

1. **读方法 0 远程 IO**：只叠加内存态（快照 + pending）。签名只暴露消费方真正要的形状——示例里从 `{success, fail}` 对象压成扁平 `Record<string, number>` 失败数。
2. **快照 = 后台/写路径刷新**：单查询、无 IN 列表（避开 bind 上限 `?100`）、只 SELECT 所用列与维度（`SUM(fail) + GROUP BY scope`，不要 provider/success 这些没人用的拆法）。
3. **pending = 精确增量子集**：本 isolate 记账后立即可见，跨 isolate 最多延迟一个刷新间隔。
4. **读门禁**：数据无消费价值时不读——候选 <2 就跳过整个统计读（权重只在 ≥2 候选时才有意义），把"读的发生次数"压到最低。

## 5. 取舍：用什么交换什么

精度置换按**优先级逐级做**（`§5.1.1`）：先用精确度换查询次数 → 再用次数换往返 → 最后才动索引。

- **展示精确 vs 信号近似 = 两套数字**，有意为之、不合并。admin 展示仍精确读 D1，代理热路径走近似信号——两者服务不同消费者，别为了"数字一致"把热路径读回来。
- **为何这次不用 Cache API/TTL**（仿的鉴权款）：数据是当前 isolate 自己 flush 产的，写路径顺带刷新既更简单又更符合语义（≈5s 新鲜），还免去全局缓存共享与失效协调；鉴权数据是**外部写的**，才需要全局缓存 + 写失效。载体跟着生产者走，不是跟着场景走。
- **不扩索引**：D1 的瓶颈是往返与单库吞吐，不是行数（小时桶聚合后每 key 每日 ≤24 行）；给 `usage_counts` 扩建覆盖索引的写放大（每 5s 全量 UPSERT）远大于省下的 heap 读。
- 残留的多批读（>98 scope 分块）→ **`DB.batch` 一次往返**取代逐批串行 await：能用一次往返解决的，绝不用 N 次。

## 6. 测试契约：怎么证明"热路径零 IO"

- 验收线：**热路径读方法内绝不触碰 `env.DB`**。
- fake D1 计数探针写回归（保持性证据，参照 `tests/usage-store.test.ts` `readUpstreamWeightSignal` 三例）：
  1. 空 base、无 pending → 读返回合理默认且 0 IO；
  2. pending 叠加正确且**不新增 IO**；
  3. flush 刷新快照一次、之后重复读不新增 IO。
- 这套断言让"某人往热路径方法里加了 env.DB 调用"立刻被测试拦下。

## 7. 检查清单（遇到"可能上热路径"的读逐条过）

1. 这条读真在热路径上吗（每次必走 + 远程 IO）？
2. 消费者要精确值吗？不需要 → 继续；安全放行决策 → 停，不套用。
3. 数据谁产的？自己写的 → 写路径刷新 + pending；别人的 → TTL + 写失效；恒定 → 一次解析。
4. 陈旧度封顶多少？冷启动行为是什么？（必须显式声明）
5. 读方法 0 远程 IO？只 SELECT 所用列？读门禁把"发生次数"压到最低？
6. fake D1 计数断言 0 查询，回归在案？

---

## 附：各载体的仓库落地位置（需要对照代码时）

| 手法 | 落点 | 原 IO → 现状 |
|---|---|---|
| 后台刷新快照 + pending（0 往返） | `usage-store.ts` `signalBase` + `readUpstreamWeightSignal`（代理选 key 权重） | 每次请求 D1 聚合 → 0 |
| Cache API + TTL + 写失效 | `storage.ts` `getDistributedKey`（每次鉴权） | D1 SELECT → Cache 命中 0 |
| 模块级 3s TTL + 写后失效 | `breaker-config.ts` `cachedBreakerConfig`、`queue-config.ts` `cachedQueueConfig`、`dist-cache-config.ts` `cachedDistCacheConfig` | 每次事件 KV get → TTL 内 0 |
| isolate 内存 MRU + pending（30s，miss 才 `.all()`） | `usage-store.ts` `weightCache` / `distCache`（admin 展示） | D1 聚合 → 命中 0 |
| 常量一次解析 | `config.ts` `resolvePublicBaseUrl` | env 读 → 一次 |
