// 领域层·重试状态机（FSM）+ 上游传输（src/retry.ts）。
// searchWithRetry 以声明式状态机驱动重试：状态（init/pick/in-flight + 终态）、
// 扁平事件（RetryEvent：每个失败类一个 kind，无子分派）、迁移表（TRANSITIONS：
// key = `${state}:${kind}`，含可选 action）+ 少量行驱动器。读取进 emit、写副作用进
// 迁移 action、请求级 bookkeeping 进 prologue。
//
// 一次请求最多尝试 MAX_ATTEMPTS 个不同上游 key，每次失败按分类走冷却/统计/换 key：
//   - 2xx        → 调用 onSuccess；返回 null 视为"成功但响应不可用"，按失败换 key 重试
//   - 429        → 换 key 重试，仅 post-use 冷却，不计熔断
//   - 400/404/422→ 客户端确定性错误：立即返回该响应，不重试、不记失败、不烧 key
//   - 401/403    → key 级错误：记统计失败（权重惩罚）+ 疑似失效长冷却（默认12h，可调），换 key
//   - 其余/网络  → 记录失败 + 指数退避冷却，换 key 重试
//   候选池耗尽或达到上限 → onFailure（透传最后一个错误响应，或 503/502）
//
// TRANSITIONS / emit / RetryState / RetryEvent / RetryContext 仅供 tests 引用
// （FSM 单测的唯一触达面，别无实现出口）。
//
// 注意：上游传输（proxyToUpstream / UPSTREAM_TIMEOUT_MS）随核在此，因为 searchWithRetry
// 内部直接调用它；若留在 proxy.ts 会造成 retry.ts ←→ proxy.ts 循环依赖。

import type { Env } from "./types";
import type { ProviderConfig } from "./providers";
import { CoreKey, hourKey } from "./domain";
import { listUpstreamKeys } from "./storage/upstream-keys";
import { getUsageStore, type UsageStore } from "./usage-store";
import {
  recordUpstreamFailure,
  recordUpstreamSuccess,
  recordUpstreamRateLimit,
  recordUpstreamInvalid,
} from "./circuit-breaker";

/** 单次请求最多尝试的上游 key 数量。 */
const MAX_ATTEMPTS = 3;

/** 单次上游请求超时（网络无响应视为失败，换 key 重试）。 */
const UPSTREAM_TIMEOUT_MS = 30_000;

/** 队列 DO 执行所需的最小依赖（替代整颗 Hono Context）。 */
export interface CoreDeps {
  env: Env;
  executionCtx: { waitUntil(p: Promise<unknown>): void };
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

/** 单个 key 当前是否可用：status=enabled 且未过 cooldown_until。 */
function isCandidate(k: CoreKey, now: number): boolean {
  return k.status === "enabled" && (k.cooldown_until == null || k.cooldown_until <= now);
}

/**
 * 加权随机：只从 status=enabled、未冷却 且 未被排除的 key 中选择；
 * 权重 = 1 / (该 key 今日失败数信号 + 1)，即失败越少权重越高（0 失败最高）。
 * statsMap 为空（单选候选时跳过统计）则退化为均匀权重。
 */
function selectUpstreamKey(
  keys: CoreKey[],
  statsMap: Record<string, number>,
  now: number = Date.now(),
  excludeIds?: Set<string>
): CoreKey | null {
  const candidates = keys.filter(
    (k) => isCandidate(k, now) && (!excludeIds || !excludeIds.has(k.id))
  );
  if (candidates.length === 0) return null;

  const weights = candidates.map((k) => {
    const fail = statsMap[k.id] ?? 0;
    return 1 / (fail + 1);
  });
  const total = weights.reduce((a, b) => a + b, 0);
  let r = Math.random() * total;
  for (let i = 0; i < candidates.length; i++) {
    r -= weights[i];
    if (r <= 0) return candidates[i];
  }
  return candidates[candidates.length - 1];
}

async function proxyToUpstream(
  def: ProviderConfig,
  path: string,
  upstreamKey: string,
  body: string,
  contentType: string
): Promise<Response> {
  const headers: Record<string, string> = {
    authorization: `Bearer ${upstreamKey}`,
    "content-type": contentType || "application/json",
  };
  return fetch(def.base + path, {
    method: "POST",
    headers,
    body,
    signal: AbortSignal.timeout(UPSTREAM_TIMEOUT_MS),
  });
}

/**
 * 上游响应状态分类，决定重试循环的非 ok 分支动作：
 *   429         → 限流，仅 post-use 冷却，换 key 重试
 *   432         → Tavily "key or plan limit exceeded"：key 粒度限额时换 key 可能成功；
 *                 配额条件非 key 故障 —— 不记败不熔断，按限流换 key 试一把
 *   433         → Tavily "PayGo limit exceeded"：Plan 余额耗尽，重试必再失败；
 *                 视为客户端确定性错误，立即返回，不重试不记败不冷却（保护共用 key 不被误伤）
 *   400/404/422 → 客户端确定性错误，立即返回，不重试
 *   401/403     → key 级错误（疑似失效），长冷却，换 key
 *   其余（5xx）  → 服务端/未知错误，失败记录 + 指数退避冷却，换 key
 */
function classifyStatus(
  status: number
): "rate-limit" | "client-error" | "auth-error" | "server-error" {
  switch (status) {
    case 429:
    case 432:
      return "rate-limit";
    case 433:
      return "client-error";
    case 400:
    case 404:
    case 422:
      return "client-error";
    case 401:
    case 403:
      return "auth-error";
    default:
      return "server-error";
  }
}

// ---- 副作用捆绑 helper：把"内存统计 + 熔断状态写入"成对打包，供迁移 action 复用 ----

/** 成功：记一次 usage 成功 + 熔断成功（连续失败归零，保留 post-use 冷却）。 */
async function markSuccess(
  store: UsageStore,
  env: Env,
  def: ProviderConfig,
  id: string,
  hour: string,
  now: number
): Promise<void> {
  store.recordUpstreamResult(id, def.name, hour, "success");
  await recordUpstreamSuccess(env, def.upstream, id, now).catch(() => {});
}

/** 非429失败：记一次 usage 失败 + 熔断失败（指数退避冷却）。 */
async function markFail(
  store: UsageStore,
  env: Env,
  def: ProviderConfig,
  id: string,
  hour: string,
  now: number
): Promise<void> {
  store.recordUpstreamResult(id, def.name, hour, "fail");
  await recordUpstreamFailure(env, def.upstream, id, now).catch(() => {});
}

/** 429：只写 post-use 冷却，不记 usage（现状行为，保持）。 */
async function markRateLimit(
  env: Env,
  def: ProviderConfig,
  id: string,
  now: number
): Promise<void> {
  await recordUpstreamRateLimit(env, def.upstream, id, now).catch(() => {});
}

/** 401/403 疑似失效：记一次 usage 失败 + 长冷却（默认12h），不碰连续失败计数。 */
async function markInvalid(
  store: UsageStore,
  env: Env,
  def: ProviderConfig,
  id: string,
  hour: string,
  now: number
): Promise<void> {
  store.recordUpstreamResult(id, def.name, hour, "fail");
  await recordUpstreamInvalid(env, def.upstream, id, now).catch(() => {});
}

// ---- 重试状态机（FSM）：状态 / 事件 / 上下文 / 迁移表 / 读取 / 渲染 ----
// 终态集合 = RetryOutcome 全部类别：success → res 直接返回；其余 → onFailure。
// usage/熔断持久态/队列 DO/协议渲染不进机器：写副作用在迁移 action，读在 emit，
// 协议渲染经 RetryCallbacks（cb）访问。

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
  env: Env;
  def: ProviderConfig;
  request: { path: string; body: string; contentType: string };
  cb: RetryCallbacks;
  store: UsageStore;
  hour: string;
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
  action?: (ctx: RetryContext, ev: RetryEvent) => Promise<void>;
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

/**
 * 迁移表：key = `${state}:${event.kind}`，每个可到事件必有迁移（缺配即驱动抛错）。
 * action 为副作用壳，复用现有 mark* helper；非重试性/终止路径无 action（现状行为）。
 */
export const TRANSITIONS: Record<string, Transition> = {
  "init:no-keys": { to: "no-keys" },
  "init:empty-candidates": { to: "unavailable" },
  "init:ready": { to: "pick" },
  "pick:picked": { to: "in-flight" },
  "pick:depleted": { to: "exhausted" },
  "in-flight:success": {
    to: "success",
    action: (ctx) =>
      markSuccess(ctx.store, ctx.env, ctx.def, ctx.currentKey!.id, ctx.hour, Date.now()),
  },
  "in-flight:unusable": {
    to: "pick",
    action: (ctx) =>
      markFail(ctx.store, ctx.env, ctx.def, ctx.currentKey!.id, ctx.hour, Date.now()),
  },
  "in-flight:network": {
    to: "pick",
    action: (ctx) =>
      markFail(ctx.store, ctx.env, ctx.def, ctx.currentKey!.id, ctx.hour, Date.now()),
  },
  "in-flight:rate-limit": {
    to: "pick",
    action: (ctx) =>
      markRateLimit(ctx.env, ctx.def, ctx.currentKey!.id, Date.now()),
  },
  "in-flight:client-error": { to: "client-error" },
  "in-flight:auth-error": {
    to: "pick",
    action: (ctx) =>
      markInvalid(ctx.store, ctx.env, ctx.def, ctx.currentKey!.id, ctx.hour, Date.now()),
  },
  "in-flight:server-error": {
    to: "pick",
    action: (ctx) =>
      markFail(ctx.store, ctx.env, ctx.def, ctx.currentKey!.id, ctx.hour, Date.now()),
  },
};

/**
 * 读取/推进：根据当前状态产出下一个事件，并就地更新 ctx（bookkeeping）。
 * 只读 + 状态推进，副作用一律留给对应迁移 action。
 */
export async function emit(state: RetryState, ctx: RetryContext): Promise<RetryEvent> {
  switch (state) {
    case "init": {
      ctx.keys = await listUpstreamKeys(ctx.env, ctx.def.upstream);
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
        res = await proxyToUpstream(
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
      switch (classifyStatus(res.status)) {
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
  const store = getUsageStore(deps.env);
  const env = deps.env;

  // prologue：增加分发 key 请求计数（success/fail 二元，进内存缓冲，尽力而为）
  const hour = hourKey();
  store.recordDistCall(apiKey, hour, "success");
  // 节流触发统计 flush（退避到 waitUntil，约每 5s 最多一次；不阻塞本请求）
  store.flushSoon(deps.executionCtx);

  const ctx: RetryContext = {
    env,
    def,
    request,
    cb,
    store,
    hour,
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
