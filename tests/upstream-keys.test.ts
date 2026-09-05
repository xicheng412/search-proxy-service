// upstream-keys 存储域测试：聚焦 keyset 分页的边界/游标语义与动态 SET 构建的 ?N 契约。
// 用脚本式 fake D1 断言"发了什么 SQL/绑定"与"返回页的 hasNext/hasPrevious/游标推导"。

import { describe, it, expect } from "vitest";
import type { Env } from "../src/types";
import { TAVILY } from "../src/providers";
import {
  listUpstreamKeysPage,
  updateUpstreamKey,
  addUpstreamKey,
} from "../src/storage/upstream-keys";
import { makeScriptedD1 } from "./helpers/fake-d1";

const def = TAVILY.upstream;

const keyRow = (id: string, created_at: number) => ({
  id,
  key: `secret-${id}`,
  name: `n-${id}`,
  status: "enabled",
  cooldown_until: null,
  created_at,
});

describe("listUpstreamKeysPage 参数校验", () => {
  it("after 与 before 互斥时拒绝", async () => {
    const { db } = makeScriptedD1([]);
    await expect(
      listUpstreamKeysPage({ DB: db } as unknown as Env, def, {
        after: { createdAt: 1, id: "a" },
        before: { createdAt: 1, id: "b" },
        limit: 2,
      })
    ).rejects.toThrow("互斥");
  });

  it("limit 非正整数时拒绝", async () => {
    const { db } = makeScriptedD1([]);
    await expect(
      listUpstreamKeysPage({ DB: db } as unknown as Env, def, {
        after: null,
        before: null,
        limit: 0,
      })
    ).rejects.toThrow("正整数");
  });
});

describe("listUpstreamKeysPage keyset 分页", () => {
  const LIMIT = 2;

  it("after 页多取一行判 hasNext；keys 只含 2 条，游标取页首/页尾", async () => {
    const rows = [keyRow("k1", 1), keyRow("k2", 2), keyRow("k3", 3)];
    const { db, log } = makeScriptedD1([{ results: rows }]);
    const page = await listUpstreamKeysPage({ DB: db } as unknown as Env, def, {
      after: { createdAt: 0, id: "k0" },
      before: null,
      limit: LIMIT,
    });
    expect(page.keys.map((k) => k.id)).toEqual(["k1", "k2"]);
    expect(page.hasNext).toBe(true);
    expect(page.hasPrevious).toBe(true);
    expect(page.nextCursor).toEqual({ createdAt: 2, id: "k2" });
    expect(page.previousCursor).toEqual({ createdAt: 1, id: "k1" });
    // LIMIT 多取一行；绑定 = provider, after.createdAt, after.id, fetchLimit
    expect(log()[0].sql).toContain("(created_at, id) >");
    expect(log()[0].binds).toEqual([def.provider, 0, "k0", LIMIT + 1]);
  });

  it("after 页无溢出行则 hasNext=false、nextCursor=null", async () => {
    const rows = [keyRow("k1", 1), keyRow("k2", 2)];
    const { db } = makeScriptedD1([{ results: rows }]);
    const page = await listUpstreamKeysPage({ DB: db } as unknown as Env, def, {
      after: { createdAt: 0, id: "k0" },
      before: null,
      limit: LIMIT,
    });
    expect(page.keys.map((k) => k.id)).toEqual(["k1", "k2"]);
    expect(page.hasNext).toBe(false);
    expect(page.nextCursor).toBeNull();
    expect(page.hasPrevious).toBe(true);
  });

  it("before 页按逆序读回、内存反转升序；溢出行判 hasPrevious", async () => {
    // DB 返回 DESC 序（新→旧）：k3,k2,k1；取前 limit 条反转后升序为 k2,k3。
    const rows = [keyRow("k3", 3), keyRow("k2", 2), keyRow("k1", 1)];
    const { db, log } = makeScriptedD1([{ results: rows }]);
    const page = await listUpstreamKeysPage({ DB: db } as unknown as Env, def, {
      after: null,
      before: { createdAt: 10, id: "k9" },
      limit: LIMIT,
    });
    expect(page.keys.map((k) => k.id)).toEqual(["k2", "k3"]);
    expect(page.hasPrevious).toBe(true);
    expect(page.hasNext).toBe(true); // before 页永远可向前
    expect(page.previousCursor).toEqual({ createdAt: 2, id: "k2" });
    expect(page.nextCursor).toEqual({ createdAt: 3, id: "k3" }); // 升序页的最后一行
    expect(log()[0].sql).toContain("(created_at, id) <");
    expect(log()[0].sql).toContain("ORDER BY created_at DESC");
    expect(log()[0].binds).toEqual([def.provider, 10, "k9", LIMIT + 1]);
  });

  it("首页（无游标）：hasPrevious=false；溢出行判 hasNext", async () => {
    const rows = [keyRow("k1", 1), keyRow("k2", 2), keyRow("k3", 3)];
    const { db, log } = makeScriptedD1([{ results: rows }]);
    const page = await listUpstreamKeysPage({ DB: db } as unknown as Env, def, {
      after: null,
      before: null,
      limit: LIMIT,
    });
    expect(page.keys.map((k) => k.id)).toEqual(["k1", "k2"]);
    expect(page.hasPrevious).toBe(false);
    expect(page.hasNext).toBe(true);
    expect(log()[0].binds).toEqual([def.provider, LIMIT + 1]);
  });

  it("空结果：双方向 false、游标 null（不抛错）", async () => {
    const { db } = makeScriptedD1([{ results: [] }]);
    const page = await listUpstreamKeysPage({ DB: db } as unknown as Env, def, {
      after: { createdAt: 5, id: "k5" },
      before: null,
      limit: LIMIT,
    });
    expect(page).toEqual({
      keys: [],
      hasPrevious: false,
      hasNext: false,
      previousCursor: null,
      nextCursor: null,
    });
  });
});

describe("updateUpstreamKey 动态 SET 与空 patch", () => {
  it("非空 patch 构建 name,status → WHERE provider/id 占位符接续", async () => {
    const patched = { ...keyRow("k1", 1), name: "n2", status: "disabled" };
    const { db, log } = makeScriptedD1([{ results: [patched] }]);
    const r = await updateUpstreamKey({ DB: db } as unknown as Env, def, "k1", {
      name: "n2",
      status: "disabled",
    });
    expect(r).toMatchObject({ id: "k1", name: "n2", status: "disabled" });
    const [call] = log();
    expect(call.op).toBe("first");
    expect(call.sql).toContain("SET name = ?1, status = ?2");
    expect(call.sql).toContain("WHERE provider = ?3 AND id = ?4");
    expect(call.binds).toEqual(["n2", "disabled", def.provider, "k1"]);
  });

  it("空 patch 走读回路径（listUpstreamKeys 一次 all，不额外 SELECT）", async () => {
    const { db, log } = makeScriptedD1([{ results: [keyRow("k1", 1)] }]);
    const r = await updateUpstreamKey({ DB: db } as unknown as Env, def, "k1", {});
    expect(r?.id).toBe("k1");
    expect(log()).toHaveLength(1);
    expect(log()[0].op).toBe("all");
  });
});

describe("addUpstreamKey 落库", () => {
  it("INSERT 全列绑定顺序与 item 一致", async () => {
    const now = 123456789;
    const { db, log } = makeScriptedD1([{ changes: 1 }]);
    const r = await addUpstreamKey({ DB: db } as unknown as Env, def, "tvly-1", "备注", now);
    expect(r).toMatchObject({ id: r.id, key: "tvly-1", name: "备注", status: "enabled", created_at: now });
    const [call] = log();
    expect(call.op).toBe("run");
    expect(call.sql).toContain("INSERT INTO upstream_keys");
    // provider,id,key,name,status,cooldown_until(null),created_at
    expect(call.binds).toEqual([def.provider, r.id, "tvly-1", "备注", "enabled", null, now]);
  });
});
