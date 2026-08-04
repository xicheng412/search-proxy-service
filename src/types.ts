// 共享类型：Worker 绑定与上下文变量。

export type Env = {
  KV: KVNamespace;
  ADMIN_PASSWORD: string;
};

export type AppVariables = {
  admin: boolean;
};
