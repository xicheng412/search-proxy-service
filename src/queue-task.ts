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
}
export type QueueTask = NativeTask | SearxngTask;
