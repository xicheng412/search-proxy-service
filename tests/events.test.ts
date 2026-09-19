// 事件分发器（src/events.ts createEventBus）单测：同步轻量分发语义。
// 只测 createEventBus（非 getEventBus 的单例装配），避免测试间共享模块级单例状态。
// 断言契约：无订阅者 no-op；多订阅者顺序调用；单订阅者抛错不中断后续；
// subscribe 幂等去重（同一函数引用重复注册只调一次——QueueDO 每任务都订阅，防记账翻倍）。

import { describe, it, expect, vi } from "vitest";
import { createEventBus } from "../src/events";
import type { DomainEvent } from "../src/domain";

describe("createEventBus 同步分发", () => {
  it("无订阅者发布 → no-op 不抛错", () => {
    const bus = createEventBus();
    const ev: DomainEvent = { type: "dist-request-accepted", apiKey: "k", at: 1, outcome: "success" };
    expect(() => bus.publish(ev)).not.toThrow();
  });

  it("多订阅者顺序调用、异常不中断", () => {
    const bus = createEventBus();
    const order: string[] = [];
    bus.subscribe(() => {
      order.push("a");
      throw new Error("subscriber boom");
    });
    bus.subscribe(() => {
      order.push("b");
    });
    bus.publish({ type: "queue-rejected", apiKey: "k" });
    expect(order).toEqual(["a", "b"]);
  });

  it("subscribe 幂等：同一函数引用重复注册只调用一次", () => {
    const bus = createEventBus();
    const spy = vi.fn();
    bus.subscribe(spy);
    bus.subscribe(spy);
    bus.publish({ type: "queue-rejected", apiKey: "k" });
    expect(spy).toHaveBeenCalledTimes(1);
  });

  it("事件对象原样透传给每个订阅者", () => {
    const bus = createEventBus();
    const seen: DomainEvent[] = [];
    bus.subscribe((ev) => seen.push(ev));
    const ev: DomainEvent = { type: "dist-request-accepted", apiKey: "k", at: 42, outcome: "fail" };
    bus.publish(ev);
    expect(seen).toEqual([ev]);
  });
});
