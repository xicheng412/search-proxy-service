// 数据面计数中间件：dist 统计直接在主 Worker 记「请求到达量」。
// 每笔通过 authenticate 鉴权的数据面请求经本中间件 +1（不区分成败、不耦合队列 DO
// 执行与否），并统一走 flushSoon 节流——原分散在各 handler / 重试核 prologue 的
// dist 事件发布已删除，dist 记账不再经事件总线。
// 口径：队列拒入 429 / 客户端断连发生在转发之后（请求确已到达）→ 计入；
// 鉴权失败在 authenticate 短路，不会到达本中间件 → 不计。

import { MiddlewareHandler } from "hono";
import type { Env, AppVariables } from "../types";
import { getUsageStore } from "../usage";
import { hourKey } from "../domain";

/** 依赖 c.var.auth（authenticate 先行注入）；handler 之前执行，「到达即 +1」。 */
export const countDist: MiddlewareHandler<{ Bindings: Env; Variables: AppVariables }> =
  async (c, next) => {
    const store = getUsageStore(c.env);
    store.recordDistCall(c.var.auth.distKey.api_key, hourKey());
    store.flushSoon(c.executionCtx);
    await next();
  };
