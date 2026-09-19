// 领域服务·RetryStateMachine：通用重试状态机核（src/domain-services/retry-state-machine.ts）。
// searchWithRetry 以声明式状态机驱动重试：状态（init/pick/in-flight + 终态）、
// 扁平事件（RetryEvent：每个失败类一个 kind，无子分派）、迁移表（TRANSITIONS：
// key = `${state}:${kind}`，含可选 action）+ 少量行驱动器。读取进 emit、写副作用进
// 迁移 action（发布领域事件）、请求级 bookkeeping 进 prologue。
//
// 一次请求最多尝试 MAX_ATTEMPTS 个不同上游 key，每次失败按分类走冷却/统计/换 key：
//   分类族枚举见 domain.ts RetryClass；编号→族映射见各 provider 描述符 statusClassMap /
//   statusClassFallback（tavily 含 432/433 专属码）；FSM 动作仍按族（事件 kind）驱动。
//   - rate-limit  → 换 key 重试，仅 post-use 冷却，不计熔断、不记 usage
//   - client-error→ 客户端确定性错误：立即返回该响应，不重试、不记失败、不烧 key
//   - auth-error  → key 级错误：记统计失败（权重惩罚）+ 疑似失效长冷却（默认12h，可调），换 key
//   - server-error→ 其余/网络：记录失败 + 指数退避冷却，换 key 重试
//   候选池耗尽或达到上限 → onFailure（透传最后一个错误响应，或 503/502）
//
// TRANSITIONS / emit / RetryState / RetryEvent / RetryContext 仅供 tests 引用
// （FSM 单测的唯一触达面，别无实现出口）。
//
// 领域服务不 import 基础设施实现（仅类型）：上游传输、事件发布、用量统计均经
// CoreDeps 端口注入（transport / events / usage，实现在组合根装配——QueueDO 的
// drain 与主 Worker 的 events 单例）。领域事件经 DomainEventSink 端口发布。

import type { Env } from "../types";
import type { ProviderConfig } from "../providers";
import type { CoreKey, DomainEventSink, RetryClass } from "../domain";
import type { UsageStore } from "../usage";
import type { KeyPool } from "../key-pool";
import { isCandidate, selectUpstreamKey } from "./selection";
import { classifyStatus } from "./classify";
import type { upstreamFetch } from "../transport";

/** 单次请求最多尝试的上游 key 数量。 */
const MAX_ATTEMPTS = 3;

/** 队列 DO 执行所需的最小依赖（替代整颗 Hono Context）。 */
export interface CoreDeps {
  env: Env;
  executionCtx: { waitUntil(p: Promise<unknown>): void };
  pool: KeyPool;
  /** 领域事件发布端口（实现注入，见 src/events.ts；保持同步，无 async 逃逸）。 */
  events: DomainEventSink;
  /** 上游传输端口（实现见 src/transport.ts；组合根注入，测试可替换）。 */
  transport: typeof upstreamFetch;
  /** 用量统计门面（实现见 src/usage；组合根注入——领域服务不直接取单例）。 */
  usage: UsageStore;
}

/** 通用重试的结果，交给 onFailure 按协议渲染最终响应。 */
export type RetryOutcome =
  | { kind: "success"; res: Response }
  | { kind: "no-keys"; lastRes: null } // 该 provider 未配置任何上游 key
  | { kind: "unavailable"; lastRes: null } // 全部冷却/禁用
  | { kind: "client-error"; lastRes: Response } // 4xx 客户端确定性错误
  | { kind: "exhausted"; lastRes: Response | null }; // 重试耗尽（可能全是网络异常，null）

export interface RetryCallbacks {
  /** 2xx 后的协议处理；返回 null 表示"成功但响应不可用"，核内按失败换 key 重试。 */
  onSuccess(res: Response): Promise<Response | null>;
  /** 最终失败渲染（含 503/502 语义），按协议决定透传或转换。 */
  onFailure(
    outcome: Exclude<RetryOutcome, { kind: "success" }>
  ): Promise<Response>;
}

// ---- 迁移 action：把"一次上游尝试结束"发布为领域事件（UpstreamAttemptSettled）----
// 冷却/统计副作用由事件订阅者（组合根）按 ev.cls 路由——本 FSM 不内联任何持久化调用；
// 六条在飞迁移共用 publishAttemptSettled，非重试/终止路径无 action（现状行为）。

// ---- 重试状态机（FSM）：状态 / 事件 / 上下文 / 迁移表 / 读取 / 渲染 ----
// 终态集合 = RetryOutcome 全部类别：success → res 直接返回；其余 → onFailure。
// usage/队列 DO/协议渲染不进机器：写副作用在迁移 action（发布领域事件），读在 emit，
// 协议渲染经 RetryCallbacks（cb）访问。
// 熔断/冷却权威态在 DO 内存池（KeyPool）：选 key 的 key 列表来自 ctx.pool（DO 内存），
// 不再每请求读 D1；事件订阅者经 pool.applyBreakerOutcome 的原地改对 ctx.keys 即刻可见。

type RetryState =
  | "init"
  | "pick"
  | "in-flight"
  | "success"
  | "no-keys"
  | "unavailable"
  | "client-error"
  | "exhausted";

type RetryEvent =
  | { kind: "no-keys" }
  | { kind: "empty-candidates" }
  | { kind: "ready" }
  | { kind: "picked"; key: CoreKey }
  | { kind: "depleted" }
  | { kind: "success"; res: Response }
  | { kind: "unusable"; res: Response }
  | { kind: "network" }
  | { kind: "rate-limit"; res: Response }
  | { kind: "client-error"; res: Response }
  | { kind: "auth-error"; res: Response }
  | { kind: "server-error"; res: Response };

interface RetryContext {
  deps: CoreDeps;
  def: ProviderConfig;
  request: { path: string; body: string; contentType: string };
  cb: RetryCallbacks;
  store: UsageStore;
  pool: KeyPool;
  keys: CoreKey[];
  statsMap: Record<string, number>;
  tried: Set<string>;
  lastRes: Response | null;
  attempt: number;
  currentKey: CoreKey | null;
}

// type 擦除，运行时无面：仅供 tests 引用（见文件头注释）
export type { RetryState, RetryEvent, RetryContext };

type Transition = {
  to: RetryState;
  // 发布领域事件为同步副作用，action 可返回 void；保留 Promise 以兼容历史 async 形态。
  action?: (ctx: RetryContext, ev: RetryEvent) => void | Promise<void>;
};

const TERMINAL = new Set<RetryState>([
  "success",
  "no-keys",
  "unavailable",
  "client-error",
  "exhausted",
]);

function isTerminal(s: RetryState): boolean {
  return TERMINAL.has(s);
}

/** 发布一次上游尝试结束的领域事件：keyId/provider 取自身，时刻取当前；调用点只传族。 */
function publishAttemptSettled(ctx: RetryContext, cls: RetryClass | "success"): void {
  ctx.deps.events.publish({
    type: "upstream-attempt-settled",
    keyId: ctx.currentKey!.id,
    provider: ctx.def.name,
    cls,
    at: Date.now(),
  });
}

/**
 * 迁移表：key = `${state}:${event.kind}`，每个可到事件必有迁移（缺配即驱动抛错）。
 * 在飞迁移的 action 统一发 UpstreamAttemptSettled（按族）；非重试性/终止路径无 action。
 */
export const TRANSITIONS: Record<string, Transition> = {
  "init:no-keys": { to: "no-keys" },
  "init:empty-candidates": { to: "unavailable" },
  "init:ready": { to: "pick" },
  "pick:picked": { to: "in-flight" },
  "pick:depleted": { to: "exhausted" },
  "in-flight:success": { to: "success", action: (ctx) => publishAttemptSettled(ctx, "success") },
  // 2xx 但响应内容不可用（上游坏）：按 server-error 族处理（记失败 + 指数退避冷却）
  "in-flight:unusable": { to: "pick", action: (ctx) => publishAttemptSettled(ctx, "server-error") },
  // 网络异常/超时：同 server-error 族
  "in-flight:network": { to: "pick", action: (ctx) => publishAttemptSettled(ctx, "server-error") },
  // 限流：仅冷却不记账——订阅者按 cls 不记 usage
  "in-flight:rate-limit": { to: "pick", action: (ctx) => publishAttemptSettled(ctx, "rate-limit") },
  "in-flight:client-error": { to: "client-error" },
  "in-flight:auth-error": { to: "pick", action: (ctx) => publishAttemptSettled(ctx, "auth-error") },
  "in-flight:server-error": { to: "pick", action: (ctx) => publishAttemptSettled(ctx, "server-error") },
};

/**
 * 读取/推进：根据当前状态产出下一个事件，并就地更新 ctx（bookkeeping）。
 * 只读 + 状态推进，副作用一律留给对应迁移 action。
 */
export async function emit(state: RetryState, ctx: RetryContext): Promise<RetryEvent> {
  switch (state) {
    case "init": {
      ctx.keys = ctx.pool.getKeys();
      if (ctx.keys.length === 0) return { kind: "no-keys" };

      const now0 = Date.now();
      const candidates = ctx.keys.filter((k) => isCandidate(k, now0));
      if (candidates.length === 0) return { kind: "empty-candidates" };

      ctx.statsMap =
        candidates.length < 2
          ? {}
          : await ctx.store.readUpstreamWeightSignal(candidates.map((k) => k.id));
      return { kind: "ready" };
    }

    case "pick": {
      if (ctx.attempt >= MAX_ATTEMPTS) return { kind: "depleted" };

      const key = selectUpstreamKey(ctx.keys, ctx.statsMap, Date.now(), ctx.tried);
      if (!key) return { kind: "depleted" };

      ctx.tried.add(key.id);
      ctx.currentKey = key;
      ctx.attempt += 1;
      return { kind: "picked", key };
    }

    case "in-flight": {
      const key = ctx.currentKey!;
      let res: Response;
      try {
        res = await ctx.deps.transport(
          ctx.def,
          ctx.request.path,
          key.key,
          ctx.request.body,
          ctx.request.contentType
        );
      } catch {
        // 网络异常/超时：lastRes 不变，交由 migration 按失败换 key
        return { kind: "network" };
      }

      if (res.ok) {
        const out = await ctx.cb.onSuccess(res);
        if (out) return { kind: "success", res: out };
        // 2xx 但响应不可用：视为失败换 key
        ctx.lastRes = res;
        return { kind: "unusable", res };
      }

      ctx.lastRes = res;
      switch (classifyStatus(ctx.def, res.status)) {
        case "rate-limit":
          return { kind: "rate-limit", res };
        case "client-error":
          return { kind: "client-error", res };
        case "auth-error":
          return { kind: "auth-error", res };
        default:
          return { kind: "server-error", res };
      }
    }

    default:
      // init/pick/in-flight 之外的（终态）状态不应再 emit
      throw new Error(`emit called in non-emitting state: ${state}`);
  }
}

/** 取携带 res 的终态事件（success / client-error）的响应；其它事件不应出现在此处。 */
function terminalRes(finalEvent: RetryEvent): Response {
  if ("res" in finalEvent) return finalEvent.res;
  throw new Error("terminal event has no res: " + finalEvent.kind);
}

/**
 * 终态渲染：state 必为终态，finalEvent 为该终态对应的最后一个事件。
 * success 直接返回 onSuccess 产物；其余按 RetryOutcome 交 cb.onFailure 协议渲染。
 */
function render(
  state: RetryState,
  finalEvent: RetryEvent,
  ctx: RetryContext,
  cb: RetryCallbacks
): Promise<Response> {
  switch (state) {
    case "success":
      return Promise.resolve(terminalRes(finalEvent)); // onSuccess 产物
    case "no-keys":
      return cb.onFailure({ kind: "no-keys", lastRes: null });
    case "unavailable":
      return cb.onFailure({ kind: "unavailable", lastRes: null });
    case "client-error":
      return cb.onFailure({ kind: "client-error", lastRes: terminalRes(finalEvent) });
    case "exhausted":
      return cb.onFailure({ kind: "exhausted", lastRes: ctx.lastRes });
    default:
      // init/pick/in-flight 不应出现在这里
      return cb.onFailure({ kind: "exhausted", lastRes: ctx.lastRes });
  }
}

/**
 * 通用重试核：鉴权后由各协议路径共用。签名与请求方 Context 解耦——只依赖 env 与
 * waitUntil，因此队列 DO（无 Hono Context）也能直接调用。
 * 以声明式状态机驱动：读取进 emit、写副作用进迁移 action、请求级 bookkeeping 进
 * prologue（见 TRANSITIONS / emit / render）。
 * - 每次尝试选不同 key；命中"不可重试"分类提前返回，避免浪费配额/流量。
 * - 无 key 配置 / 全部冷却禁用 → 503（经 onFailure 渲染）。
 */
export async function searchWithRetry(
  deps: CoreDeps,
  def: ProviderConfig,
  apiKey: string,
  request: { path: string; body: string; contentType: string },
  cb: RetryCallbacks
): Promise<Response> {
  const store = deps.usage;

  // prologue：分发 key 请求被受理（成功）——发布领域事件，dist 统计由事件订阅者
  // 同步记账（等价旧 recordDistCall(apiKey, hour, "success")，小时桶由订阅者换算）。
  deps.events.publish({
    type: "dist-request-accepted",
    apiKey,
    at: Date.now(),
    outcome: "success",
  });
  // 节流触发统计 flush（退避到 waitUntil，双阈值 ≥30min/256 条；不阻塞本请求）
  store.flushSoon(deps.executionCtx);

  const ctx: RetryContext = {
    deps,
    def,
    request,
    cb,
    store,
    pool: deps.pool,
    keys: [],
    statsMap: {},
    tried: new Set(),
    lastRes: null,
    attempt: 0,
    currentKey: null,
  };

  // 驱动器：迁移表 + isTerminal + render，表即文档
  let state: RetryState = "init";
  let finalEvent: RetryEvent | null = null;
  while (!isTerminal(state)) {
    const ev = await emit(state, ctx);
    const tr: Transition = TRANSITIONS[`${state}:${ev.kind}`]!; // 每 (state,kind) 必有迁移（见表）
    await tr.action?.(ctx, ev);
    state = tr.to;
    finalEvent = ev;
  }
  return render(state, finalEvent!, ctx, cb);
}
