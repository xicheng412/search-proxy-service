// 共享测试基础设施：installFakeCaches —— 替换全局 caches.default 的进程内实现。
// 存 JSON，match 时重建 Response（避免 Response body 流被消费一次后不可复用）。
// match/put/delete 全部记录进 calls，供断言"读穿路径命中/写穿/失效"。

export interface CacheCall {
  op: "match" | "put" | "delete";
  url: string;
}

export interface FakeCachesController {
  calls(): CacheCall[];
  /** 读取当前缓存 JSON（无则 undefined）。返回克隆的 Response，可再次 json()。 */
  get(url: string): Promise<Response | undefined>;
  /** 还原调用前的 globalThis.caches。 */
  restore(): void;
}

export function installFakeCaches(
  seed: Record<string, unknown> = {}
): FakeCachesController {
  const store = new Map<string, { body: unknown; cc: string }>();
  for (const [url, body] of Object.entries(seed)) store.set(url, { body, cc: "" });

  const calls: CacheCall[] = [];
  const makeResp = (e: { body: unknown; cc: string }) =>
    new Response(JSON.stringify(e.body), {
      headers: { "cache-control": e.cc },
    });

  const match = async (url: string) => {
    calls.push({ op: "match", url });
    const e = store.get(url);
    return e ? makeResp(e) : undefined;
  };
  const put = async (url: string, resp: Response) => {
    calls.push({ op: "put", url });
    const body: unknown = await resp.json();
    const cc = resp.headers.get("cache-control") ?? "";
    store.set(url, { body, cc });
  };
  const del = async (url: string) => {
    calls.push({ op: "delete", url });
    return store.delete(url);
  };

  const g = globalThis as unknown as { caches?: { default: unknown } };
  const prev = g.caches;
  g.caches = { default: { match, put, delete: del } };

  return {
    calls: () => calls,
    get: async (url: string) => {
      const e = store.get(url);
      return e ? makeResp(e) : undefined;
    },
    restore: () => {
      if (prev === undefined) delete g.caches;
      else g.caches = prev;
    },
  };
}
