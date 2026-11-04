// 队列任务 DTO（叶子模块，零 import）：主 Worker 鉴权后把"一次相对上游的请求"打成可序列化
// 任务，转发给所属 provider 的队列 DO；DO 串行放行后调用执行器。本模块只声明任务契约，
// 不依赖任何运行时模块（纯类型，供 proxy.ts / queue.ts 及未来代码共享）。

export interface NativeTask {
  kind: "native";
  path: string;
  body: string;
  contentType: string;
}
export interface SearxngTask {
  kind: "searxng";
  query: string;
  topic?: "news" | "general" | undefined;
  body: string;
  contentType: string;
  // searxng 协议仅服务 Search 能力（无 path 字段：协议层绑定 Search，上游 path 由 provider 描述符决定）。
}
export interface ReaderTask {
  kind: "reader";
  url: string;
  depth: "basic" | "advanced"; // Tavily extract_depth；白名单值，见 adapters/reader
  // reader 协议仅服务 Extract 能力（无 path/body 字段：协议层绑定 Extract，上游 path/请求体由 provider 描述符 + adapters/reader 决定）。
}
export type QueueTask = NativeTask | SearxngTask | ReaderTask;

/** 入站任务边界解析:未知 kind 或字段类型不符一律返回 null(调用方按 400 拒绝)。
 *  结构校验替代 durable-object 的 `as typeof payload` 强转,杜绝未知 kind 静默落到 SearXNG。 */
export function parseQueueTask(raw: unknown): QueueTask | null {
  if (typeof raw !== "object" || raw === null) return null;
  const t = raw as Record<string, unknown>;
  if (t["kind"] === "native") {
    if (typeof t["path"] !== "string" || typeof t["body"] !== "string" || typeof t["contentType"] !== "string") return null;
    return { kind: "native", path: t["path"], body: t["body"], contentType: t["contentType"] };
  }
  if (t["kind"] === "searxng") {
    if (typeof t["query"] !== "string" || typeof t["body"] !== "string" || typeof t["contentType"] !== "string") return null;
    const topic = t["topic"];
    if (topic !== undefined && topic !== "news" && topic !== "general") return null;
    return { kind: "searxng", query: t["query"], topic: topic as "news" | "general" | undefined, body: t["body"], contentType: t["contentType"] };
  }
  if (t["kind"] === "reader") {
    const depth = t["depth"];
    if (typeof t["url"] !== "string" || (depth !== "basic" && depth !== "advanced")) return null;
    return { kind: "reader", url: t["url"], depth };
  }
  return null;
}
