// vitest（node 环境）用的 Cloudflare 专属模块桩：
// 把 `cloudflare:workers` 解析到本地类，让整包引入 src/index 的冒烟测试能加载。
// 测试直接实例化 QueueDO 时需要 base 类把 (state, env) 挂到 this.ctx / this.env
// （QueueDO 读 this.env 的 KV/DB，并在 drain 里调用 this.ctx.waitUntil）。

export class DurableObject<Env = unknown> {
  ctx: { waitUntil(p: Promise<unknown>): void };
  env: Env;
  constructor(state: unknown, env: Env) {
    this.ctx = state as { waitUntil(p: Promise<unknown>): void };
    this.env = env;
  }
}
