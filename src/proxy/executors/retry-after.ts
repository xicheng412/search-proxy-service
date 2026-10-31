// 响应包装：给已构造的错误响应补 Retry-After 头（全冷却超预算的 429 用）。
// 独立小模块：`durable-object.ts` 的 rateLimitResponse 是私有函数且需要
// def/task/cfg，executors 复用它会形成 durable-object ↔ executors 循环依赖。

/** 给已构造的错误响应补 Retry-After（秒，向上取整、最小 1）。 */
export function withRetryAfter(res: Response, seconds: number): Response {
  const headers = new Headers(res.headers);
  headers.set("retry-after", String(Math.max(1, Math.ceil(seconds))));
  return new Response(res.body, {
    status: res.status,
    statusText: res.statusText,
    headers,
  });
}
