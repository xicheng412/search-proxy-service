// 基础设施层·同步轻量事件分发器（非总线）。
// 领域事件（domain.ts DomainEvent）经订阅者消费：发布 = 同步遍历订阅者列表，
// 与现有 mark* `.catch(()=>{})` 语义一致——任一订阅者抛错被捕获后继续下一个，
// 不中断发布者，也不逃逸 async。各 isolate 一份单例（getEventBus，仿 getUsageStore），
// 组合根在首次创建时注册通用订阅（见 getEventBus）；QueueDO 额外注册上游结果订阅（幂等）。
// 分层约束：domain.ts（纯类型）与领域服务不 import 本模块——领域侧只依赖 DomainEventSink
// 端口接口（依赖倒置），实现在此经组合根注入。

import type { Env } from "./types";
import type { DomainEvent, DomainEventSink } from "./domain";
import { hourKey } from "./domain";
import { getUsageStore } from "./usage";

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
 * per-isolate 惰性单例。首次创建时自动注册通用订阅（无 pool 依赖，主 Worker 与 QueueDO 共用）：
 * - DistRequestAccepted → getUsageStore(env).recordDistCall(apiKey, hourKey(at), outcome)
 * - QueueRejected → 显式 no-op（把「不计统计」从 by-omission 变显式；未来诊断在此挂读模型）
 */
export function getEventBus(env: Env): DomainEventBus {
  if (!defaultBus) {
    defaultBus = createEventBus();
    registerGeneralSubscribers(defaultBus, env);
  }
  return defaultBus;
}

function registerGeneralSubscribers(bus: DomainEventBus, env: Env): void {
  bus.subscribe((ev) => {
    if (ev.type !== "dist-request-accepted") return;
    getUsageStore(env).recordDistCall(ev.apiKey, hourKey(ev.at), ev.outcome);
  });
  bus.subscribe((ev) => {
    if (ev.type !== "queue-rejected") return;
    // 拒入/超时的分发 key 不计统计（显式 no-op，见文件头）；仅作类型收纳，未来诊断挂读模型。
  });
}
