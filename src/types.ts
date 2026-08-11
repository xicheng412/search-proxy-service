// 共享类型：Worker 绑定与上下文变量。

export type Env = {
  KV: KVNamespace;
  /** 每 provider 一把队列 DO（idFromName(provider)），串行放行上游请求。 */
  QUEUE: DurableObjectNamespace;
  ADMIN_PASSWORD: string;
  /** 对外 API 地址（调用方访问本服务的 origin）。经部署脚本从 gitignored config/prod.env 注入；本地 .dev.vars 覆盖；唯一取值在 config.ts。 */
  PUBLIC_BASE_URL: string;
};

export type AppVariables = {
  admin: boolean;
};
