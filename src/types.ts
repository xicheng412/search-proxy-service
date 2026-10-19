// 共享类型：Worker 绑定与上下文变量。

import type { DistributedKey, DistAuth } from "./domain";

export type Env = {
  KV: KVNamespace;
  /** D1 数据库：实体数据（上游/分发 key、用量小时桶、熔断状态）。 */
  DB: D1Database;
  /** 每 provider 一把队列 DO（idFromName(provider)），串行放行上游请求。 */
  QUEUE: DurableObjectNamespace;
  ADMIN_PASSWORD: string;
  /** 对外 API 地址（调用方访问本服务的 origin）。经部署脚本从 gitignored config/prod.env 注入；本地 .dev.vars 覆盖；唯一取值在 config.ts。 */
  PUBLIC_BASE_URL: string;
};

/** 数据面鉴权结果：由 authenticate 中间件注入 c.var.auth，供各 handler 直接消费。
 *  credential 是 domain 层的复合前缀解析结果（DistAuth）；distKey 是查库得到的实体。
 *  protocol/provider/apiKey 一律从 credential 读取，避免与 DistAuth 平行复制字段。 */
export interface AuthContext {
  credential: DistAuth;
  distKey: DistributedKey;
}

export type AppVariables = {
  admin: boolean;
  auth: AuthContext;
};
