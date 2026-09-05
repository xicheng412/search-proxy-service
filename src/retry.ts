// 领域层·重试策略核 + 上游传输（searchWithRetry）。
// 一次请求最多尝试 MAX_ATTEMPTS 个不同上游 key，每次失败按分类走冷却/统计/换 key：
//   - 2xx        → 调用 onSuccess；返回 null 视为"成功但响应不可用"，按失败换 key 重试
//   - 429        → 换 key 重试，仅 post-use 冷却，不计熔断
//   - 400/404/422→ 客户端确定性错误：立即返回该响应，不重试、不记失败、不烧 key
//   - 401/403    → key 级错误：记统计失败（权重惩罚）+ 疑似失效长冷却（默认12h，可调），换 key
//   - 其余/网络  → 记录失败 + 指数退避冷却，换 key 重试
//   候选池耗尽或达到上限 → onFailure（透传最后一个错误响应，或 503/502）
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
 *   400/404/422 → 客户端确定性错误，立即返回，不重试
 *   401/403     → key 级错误（疑似失效），长冷却，换 key
 *   其余（5xx）  → 服务端/未知错误，失败记录 + 指数退避冷却，换 key
 */
function classifyStatus(
  status: number
): "rate-limit" | "client-error" | "auth-error" | "server-error" {
  switch (status) {
    case 429:
      return "rate-limit";
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

// ---- 副作用捆绑 helper：把"内存统计 + 熔断状态写入"成对打包，供重试循环各分支复用 ----

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

/**
 * 通用重试核：鉴权后由各协议路径共用。签名与请求方 Context 解耦——只依赖 env 与
 * waitUntil，因此队列 DO（无 Hono Context）也能直接调用。
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

  // 1. 增加分发 key 调用计数（按 provider + 结果拆分，进内存缓冲，尽力而为）
  const hour = hourKey();
  store.recordDistCall(apiKey, def.name, hour, "success");
  // 节流触发统计 flush（退避到 waitUntil，约每 5s 最多一次；不阻塞本请求）
  store.flushSoon(deps.executionCtx);

  // 2. 选出该 provider 的上游 key；未配置任何 key -> 503
  const keys = await listUpstreamKeys(env, def.upstream);
  if (keys.length === 0) {
    return cb.onFailure({ kind: "no-keys", lastRes: null });
  }

  // 3. 候选预检：全部冷却/禁用 -> 503；仅候选 ≥2 才读权重信号（内存信号，0 次 D1 往返）
  const now0 = Date.now();
  const candidates = keys.filter((k) => isCandidate(k, now0));
  if (candidates.length === 0) {
    return cb.onFailure({ kind: "unavailable", lastRes: null });
  }
  const statsMap =
    candidates.length < 2 ? {} : await store.readUpstreamWeightSignal(candidates.map((k) => k.id));

  const tried = new Set<string>();
  let lastRes: Response | null = null;

  // 4. 重试循环：最多 MAX_ATTEMPTS 次，每次选不同的 key
  for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt++) {
    const now = Date.now();
    const key = selectUpstreamKey(keys, statsMap, now, tried);
    if (!key) break; // 候选池耗尽
    tried.add(key.id);

    // 发起上游请求（fetch 可能抛出网络异常/超时）
    let res: Response;
    try {
      res = await proxyToUpstream(def, request.path, key.key, request.body, request.contentType);
    } catch {
      // 网络异常/超时：视为失败，换 key 重试
      await markFail(store, env, def, key.id, hour, now);
      continue;
    }

    // 2xx 成功 → 交给 onSuccess；返回 null 表示响应不可用，按失败换 key
    if (res.ok) {
      const out = await cb.onSuccess(res);
      if (out) {
        await markSuccess(store, env, def, key.id, hour, now);
        return out;
      }
      lastRes = res;
      await markFail(store, env, def, key.id, hour, now);
      continue;
    }

    lastRes = res;

    // 非 ok 分支：按状态分类处理（429 不客户端终止；400/404/422 立即返回；401/403 换 key）
    switch (classifyStatus(res.status)) {
      case "rate-limit":
        await markRateLimit(env, def, key.id, now);
        continue;
      case "client-error":
        return cb.onFailure({ kind: "client-error", lastRes: res });
      case "auth-error":
        await markInvalid(store, env, def, key.id, hour, now);
        continue;
      case "server-error":
        await markFail(store, env, def, key.id, hour, now);
        continue;
    }
  }

  // 5. 重试耗尽 → onFailure（透传最后错误响应，或 503/502）
  return cb.onFailure({ kind: "exhausted", lastRes });
}
