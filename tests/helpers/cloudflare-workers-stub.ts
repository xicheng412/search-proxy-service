// vitest（node 环境）用的 Cloudflare 专属模块桩：
// 把 `cloudflare:workers` 解析到本地类，让整包引入 src/index 的冒烟测试能加载
//（queue.ts 继承 DurableObject；测试不实例化 QueueDO，桩只需类存在）。
// 本目录不进 tsconfig include，无需 @cloudflare/workers-types 即可编译。

export class DurableObject<Env = unknown> {
  constructor(_state: unknown, _env: Env) {}
}
