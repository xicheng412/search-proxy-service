// 基础设施层·同步轻量事件分发器（非总线）。
// 领域事件（domain.ts DomainEvent）经订阅者消费：发布 = 同步遍历订阅者列表，
// 与现有 mark* `.catch(()=>{})` 语义一致——任一订阅者抛错被捕获后继续下一个，
// 不中断发布者，也不逃逸 async。各 isolate 一份单例（getEventBus，仿 getUsageStore）。
// 仅服务 UpstreamAttemptSettled（QueueDO 侧注册），无通用订阅：dist 已迁主 Worker
// 计数（countDist 中间件直记，不经事件总线）。
// 分层约束：domain.ts（纯类型）与领域服务不 import 本模块——领域侧只依赖 DomainEventSink
// 端口接口（依赖倒置），实现在此经组合根注入。

import type { DomainEvent, DomainEventSink } from "./domain";

export type EventSubscriber = (ev: DomainEvent) => void | Promise<void>;

export interface DomainEventBus extends DomainEventSink {
  subscribe(sub: EventSubscriber): void;
}

/**
 * 顺序订阅者列表；发布同步遍历，单个订阅者抛错 catch 后继续（不中断其它订阅者与发布者）。
 * subscribe 幂等：同一函数引用重复注册去重（Set 存储），避免组合根重复订阅导致记账翻倍
 * （QueueDO 的 drain 每任务都走订阅注册路径，必须靠幂等兜底）。
 */
export function createEventBus(): DomainEventBus {
  const subs = new Set<EventSubscriber>();
  return {
    publish(ev: DomainEvent): void {
      for (const sub of subs) {
        try {
          sub(ev);
        } catch {
          // 出错订阅者不影响其余订阅者与发布者（与 mark* 的 .catch(()=>{}) 语义一致）
        }
      }
    },
    subscribe(sub: EventSubscriber): void {
      subs.add(sub);
    },
  };
}

// ---- 每 isolate 一份的默认实例（主 Worker 与 QueueDO 共用同一定义）----
let defaultBus: DomainEventBus | null = null;

/**
 * per-isolate 惰性单例（无参）。不再注册通用订阅：上游结果订阅由 QueueDO 的
 * ensureBus 在自身 isolate 注册（幂等单次，见 durable-object.ts），getEventBus 只负责取用单例。
 */
export function getEventBus(): DomainEventBus {
  if (!defaultBus) {
    defaultBus = createEventBus();
  }
  return defaultBus;
}
