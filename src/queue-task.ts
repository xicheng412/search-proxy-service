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
  topic?: "news" | "general";
  body: string;
  contentType: string;
  // searxng 协议仅服务 Search 能力（无 path 字段：协议层绑定 Search，上游 path 由 provider 描述符决定）。
}
export interface ReaderTask {
  kind: "reader";
  url: string;
  // reader 协议仅服务 Extract 能力（无 path/body 字段：协议层绑定 Extract，上游 path/请求体由 provider 描述符 + adapters/reader 决定）。
}
export type QueueTask = NativeTask | SearxngTask | ReaderTask;
