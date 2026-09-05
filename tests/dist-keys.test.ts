// dist-keys 存储域测试：getDistributedKey 的 Cache 读穿/负缓存/降级，
// generate/update/delete 的"写操作失效缓存"关键路径。
// caches 为全局单例，测试前用 installFakeCaches 注入并记录调用，afterEach 还原。

import { describe, it, expect, afterEach } from "vitest";
import type { Env } from "../src/types";
import {
  getDistributedKey,
  generateDistributedKey,
  updateDistributedKey,
  deleteDistributedKey,
} from "../src/storage/dist-keys";
import { makeScriptedD1 } from "./helpers/fake-d1";
import { installFakeCaches, FakeCachesController } from "./helpers/fake-caches";

const url = (apiKey: string) => `https://search-proxy.internal/dist-key/${apiKey}`;
const row = { api_key: "ak", note: "n1", status: "enabled", created_at: 1 };

const makeEnv = (db: unknown) =>
  ({ DB: db, KV: { get: async () => null } } as unknown as Env);

let ctl: FakeCachesController | null = null;
afterEach(() => {
  ctl?.restore();
  ctl = null;
});
const install = (seed: Record<string, unknown> = {}) => (ctl = installFakeCaches(seed));

describe("getDistributedKey 读穿缓存", () => {
  it("冷读：cache miss → DB first 命中 → 写回 cache，返回 key", async () => {
    const c = install();
    const { db, log } = makeScriptedD1([{ results: [row] }]);
    const key = await getDistributedKey(makeEnv(db), "ak");
    expect(key).toMatchObject({ api_key: "ak", status: "enabled" });
    expect(log()).toHaveLength(1);
    expect(log()[0].op).toBe("first");
    const puts = c.calls().filter((x) => x.op === "put");
    expect(puts).toHaveLength(1);
    expect(puts[0].url).toBe(url("ak"));
    const cached = await c.get(url("ak"));
    await expect(cached?.json()).resolves.toMatchObject({
      found: true,
      key: { api_key: "ak" },
    });
  });

  it("负缓存命中：cache 有 {found:false} 则直接返回 null，不查 DB", async () => {
    const c = install({ [url("ak")]: { found: false, key: undefined } });
    const { db, log } = makeScriptedD1([]);
    await expect(getDistributedKey(makeEnv(db), "ak")).resolves.toBeNull();
    expect(log()).toHaveLength(0);
    expect(c.calls().filter((x) => x.op === "match")).toHaveLength(1);
  });

  it("DB 未命中也写负缓存", async () => {
    const c = install();
    const { db } = makeScriptedD1([{ results: [] }]);
    await expect(getDistributedKey(makeEnv(db), "ak")).resolves.toBeNull();
    expect(c.calls().filter((x) => x.op === "put")).toHaveLength(1);
    const cached = await c.get(url("ak"));
    await expect(cached?.json()).resolves.toEqual({ found: false, key: undefined });
  });

  it("cache 读写失败静默：回退 DB，命中返回 / 未命中 null，不抛", async () => {
    const prev = (globalThis as unknown as { caches?: unknown }).caches;
    (globalThis as unknown as { caches: unknown }).caches = {
      default: {
        match: async () => {
          throw new Error("cache down");
        },
        put: async () => {
          throw new Error("cache down");
        },
        delete: async () => {
          throw new Error("cache down");
        },
      },
    };
    try {
      const hit = makeScriptedD1([{ results: [row] }]);
      await expect(getDistributedKey(makeEnv(hit.db), "ak")).resolves.toMatchObject({
        api_key: "ak",
      });
      const miss = makeScriptedD1([{ results: [] }]);
      await expect(getDistributedKey(makeEnv(miss.db), "ak")).resolves.toBeNull();
    } finally {
      if (prev === undefined) delete (globalThis as unknown as { caches?: unknown }).caches;
      else (globalThis as unknown as { caches: unknown }).caches = prev;
    }
  });
});

describe("写操作失效缓存", () => {
  it("generateDistributedKey：无碰撞 → INSERT 后删除该 key 缓存", async () => {
    const c = install();
    const { db, log } = makeScriptedD1([
      { results: [] }, // first 查碰撞：无结果
      { changes: 1 }, // INSERT
    ]);
    const key = await generateDistributedKey(makeEnv(db), "note-1");
    expect(key).toMatchObject({ note: "note-1", status: "enabled" });
    const dels = c.calls().filter((x) => x.op === "delete");
    expect(dels).toHaveLength(1);
    expect(dels[0].url).toBe(url(key.api_key));
    expect(log()).toHaveLength(2);
  });

  it("updateDistributedKey：更新成功 → 删除该 key 缓存", async () => {
    const c = install();
    const patched = { ...row, note: "n2", status: "disabled" };
    const { db, log } = makeScriptedD1([{ results: [patched] }]);
    const key = await updateDistributedKey(makeEnv(db), "ak", { status: "disabled" });
    expect(key).toMatchObject({ status: "disabled" });
    expect(log()[0].binds).toEqual(["disabled", "ak"]);
    expect(c.calls().filter((x) => x.op === "delete" && x.url === url("ak"))).toHaveLength(1);
  });

  it("deleteDistributedKey：删除行 + 失效缓存，返回 changes>0", async () => {
    const c = install();
    const { db } = makeScriptedD1([{ changes: 1 }]);
    await expect(deleteDistributedKey(makeEnv(db), "ak")).resolves.toBe(true);
    expect(c.calls().filter((x) => x.op === "delete" && x.url === url("ak"))).toHaveLength(1);
  });
});
