// 队列 DO 的上游结果订阅者（UpstreamAttemptSettled 消费端）。
// 分层：本模块是基础设施；领域服务（retry-state-machine）只发事件、不经本模块。
// 关键约束——订阅者不得持有任何 DO 实例：
//   事件总线 getEventBus 是模块级单例，跨 DO 实例回收/重建存活。若按 DO 实例注册
//   （闭包捕获 this），实例重建后总线残留旧闭包，同一 UpstreamAttemptSettled 会被
//   N 个旧闭包各消费一次 → usage / 冷却记账翻 N 倍（dist 订阅注册在 events.ts 仅一次，
//   不受影响）。故池经 poolOf 惰性解析（durable-object 的模块级 activePools），
//   始终指向当前活跃实例的 KeyPool。
//
// 记账语义（与旧 mark* 表一致）：auth/server-error→fail、success→success、rate-limit→不记。

import type { Env } from "../types";
import type { Provider } from "../domain";
import { hourKey } from "../domain";
import type { KeyPool } from "../key-pool";
import type { EventSubscriber } from "../events";
import { getUsageStore } from "../usage";
import { recordUpstreamOutcome } from "../circuit-breaker";

/** 事件对 provider → 当前活跃 KeyPool 的解析（跨 DO 重建指向最新实例；null = 尚未建立）。 */
export type PoolResolver = (provider: Provider) => KeyPool | null;

export function makeUpstreamSubscriber(env: Env, poolOf: PoolResolver): EventSubscriber {
  return (ev) => {
    if (ev.type !== "upstream-attempt-settled") return;
    // 惰性取池：注册时池可能尚未建立（FSM 在本 DO 内产生事件时必然已建，防御性判空）。
    const pool = poolOf(ev.provider);
    if (!pool) return;
    const store = getUsageStore(env);
    // 冷却：按 cls 走同一策略（client-error 不会被发事件，见 retry FSM）。
    // 返回 promise 供测试确定性 await（总线 publish 忽略返回值，不逃逸错误：内部已 .catch）。
    const cooldown = recordUpstreamOutcome(env, pool, ev.keyId, ev.cls, ev.at).catch(() => {});
    // usage 记账：success→success、auth/server-error→fail；rate-limit 与 client-error 不记
    // （client-error 理论上不入事件，防御性忽略，避免误记 fail）。
    if (ev.cls === "success") {
      store.recordUpstreamResult(ev.keyId, ev.provider, hourKey(ev.at), "success");
    } else if (ev.cls === "auth-error" || ev.cls === "server-error") {
      store.recordUpstreamResult(ev.keyId, ev.provider, hourKey(ev.at), "fail");
    }
    return cooldown;
  };
}
