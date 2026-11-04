import { describe, expect, it } from "vitest";
import { parseQueueTask } from "../../src/queue/task";

describe("parseQueueTask", () => {
  it("接受合法的 native 任务", () => {
    expect(parseQueueTask({ kind: "native", path: "/search", body: "{}", contentType: "application/json" }))
      .toEqual({ kind: "native", path: "/search", body: "{}", contentType: "application/json" });
  });
  it("接受合法的 searxng 任务(topic 可缺省)", () => {
    expect(parseQueueTask({ kind: "searxng", query: "q", body: "{}", contentType: "application/json" }))
      .toStrictEqual({ kind: "searxng", query: "q", topic: undefined, body: "{}", contentType: "application/json" });
  });
  it("拒绝越界 topic", () => {
    expect(parseQueueTask({ kind: "searxng", query: "q", topic: "banana", body: "{}", contentType: "application/json" })).toBeNull();
  });
  it("接受合法的 reader 任务", () => {
    expect(parseQueueTask({ kind: "reader", url: "https://a.example", depth: "basic" }))
      .toEqual({ kind: "reader", url: "https://a.example", depth: "basic" });
  });
  it("拒绝未知 kind,不静默走 SearXNG", () => {
    expect(parseQueueTask({ kind: "foobar", query: "q" })).toBeNull();
  });
  it("拒绝字段缺失或类型不符", () => {
    expect(parseQueueTask({ kind: "native", path: "/search" })).toBeNull();
    expect(parseQueueTask({ kind: "reader", url: "u", depth: "banana" })).toBeNull();
    expect(parseQueueTask(null)).toBeNull();
    expect(parseQueueTask("native")).toBeNull();
  });
});
