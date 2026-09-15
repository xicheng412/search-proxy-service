// 拆分后的两个页面渲染契约测试：login 页两种状态（无错误提示 / error=1 显示错误），
// 以及已登录 GET /admin 的 dashboard 全要素（统计卡 total/enabled 映射、三组配置
// KV 缺省回填、图表序列 JSON 注入、layout 外壳与导航高亮）。
// 走真实 worker.fetch（路由装配 + 视图拆分完整路径）；DB 按 SQL 形态 + binds 内容
// 分派（不依赖调用顺序），KV 用内存 map 供"登录后"注入会话；未知 DB 调用直接 throw。

import { describe, it, expect } from "vitest";
import worker from "../src/index";
import type { Env } from "../src/types";

type Row = Record<string, unknown>;

const SCRIPTED: Record<string, Row[]> = {
  // readSeriesByProvider 的 .all()：binds = (kind, minHour)
  upstream: [{ hour: "2026-09-14T00:00", provider: "tavily", success: 3, fail: 1 }],
  // dist 行无 provider 维度（provider 为 NULL）
  dist: [{ hour: "2026-09-14T00:00", provider: null, success: 9, fail: 0 }],
};

function makeStatement(sql: string, binds: unknown[]) {
  const all = async (): Promise<{ results: Row[] }> => {
    const kind = binds[0];
    if (kind === "upstream" || kind === "dist") {
      return { results: SCRIPTED[kind as "upstream" | "dist"] };
    }
    throw new Error(`unexpected DB call: ${sql}`);
  };
  const first = async (): Promise<Row | null> => {
    // countUpstreamKeys 绑定 def.provider；countDistributedKeys 无绑定
    if (binds[0] === "tavily") return { total: 3, enabled: 2 };
    if (binds[0] === "exa") return { total: 5, enabled: 4 };
    if (binds.length === 0) return { total: 7, enabled: 6 };
    throw new Error(`unexpected DB call: ${sql}`);
  };
  const run = async (): Promise<unknown> => {
    throw new Error(`unexpected DB call: ${sql}`);
  };
  return {
    all,
    first,
    run,
    bind: (...b: unknown[]) => makeStatement(sql, b),
  };
}

const scriptedDb = {
  prepare: (sql: string) => makeStatement(sql, []),
};

// 内存 map KV：支持"登录后"注入会话（dashboard case）；登录页 case 不注入即未登录。
const kvStore = new Map<string, string>();
const kv = {
  get: async (k: string) => kvStore.get(k) ?? null,
  put: async (k: string, v: string) => {
    kvStore.set(k, v);
  },
  delete: async (k: string) => {
    kvStore.delete(k);
  },
};

const env = {
  ADMIN_PASSWORD: "admin-pass",
  KV: kv,
  PUBLIC_BASE_URL: "https://proxy.example",
  DB: scriptedDb,
  QUEUE: { idFromName: () => "0" },
} as unknown as Env;

function get(path: string, headers: Record<string, string> = {}) {
  return worker.fetch(new Request("https://proxy.example" + path, { headers }), env, {
    waitUntil: () => {},
  } as unknown as ExecutionContext);
}

// 取 `<script ... id="X">…</script>` 的正文（断言图表 JSON 注入内容）。
function scriptBody(html: string, id: string): string {
  const marker = `id="${id}">`;
  const start = html.indexOf(marker);
  expect(start).toBeGreaterThan(0);
  return html.slice(start + marker.length, html.indexOf("</script>", start));
}

describe("login 页（views/login.ts）", () => {
  it("GET /admin/login 无 error → 无错误提示", async () => {
    const res = await get("/admin/login");
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toContain("text/html");
    const html = await res.text();
    expect(html).toContain("Tavily Proxy 管理后台");
    expect(html).toContain('name="password"');
    expect(html).toContain('action="/admin/login"');
    expect(html).not.toContain("密码错误");
  });

  it("GET /admin/login?error=1 → 显示错误提示", async () => {
    const res = await get("/admin/login?error=1");
    expect(res.status).toBe(200);
    const html = await res.text();
    expect(html).toContain("密码错误，请重试");
  });
});

describe("dashboard 总览页（views/dashboard.ts）", () => {
  it("已登录 GET /admin → 统计卡、配置回填、图表 JSON、layout 外壳全要素渲染", async () => {
    // 会话格式与 src/auth.ts createSession 的 KV 写入一致
    kvStore.set(
      "session:sid-1",
      JSON.stringify({
        created_at: Date.now(),
        expires_at: Date.now() + 86_400_000,
        csrf: "csrf-token-123",
      })
    );

    const res = await get("/admin", { cookie: "admin_session=sid-1" });
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toContain("text/html");
    const html = await res.text();

    // 统计卡：total 注入 + 停用 = total - enabled
    expect(html).toContain('<div class="stat-num">3</div>');
    expect(html).toContain(">5</div>");
    expect(html).toContain(">7</div>");
    expect(html).toContain("启用 2 · 停用 1");
    expect(html).toContain("启用 4 · 停用 1");
    expect(html).toContain("启用 6 · 停用 1");

    // 三组配置表单：KV 未写 → 全部缺省值回填
    expect(html).toContain('name="intervalMs" min="100" value="3000"');
    expect(html).toContain('name="maxDepth" min="1" value="10"');
    expect(html).toContain('name="waitBudgetMs" min="1000" value="30000"');
    expect(html).toContain('name="postUseCooldownSec" min="0" step="1" value="10"');
    expect(html).toContain('name="breakerBaseSec" min="1" step="1" value="600"');
    expect(html).toContain('name="invalidCooldownSec" min="1" step="1" value="43200"');
    expect(html).toContain('name="cacheTtlSec" min="1" step="1" value="300"');

    // 三个表单各带会话 csrf 隐藏字段
    expect(
      (html.match(/name="csrf_token" value="csrf-token-123"/g) ?? []).length
    ).toBe(3);

    // 图表序列 JSON 注入（raw JSON，非 HTML esc：引号原样）
    const dist = scriptBody(html, "dist-series");
    expect(dist).toContain('"hour":"2026-09-14T00:00"');
    expect(dist).toContain('"calls":9');
    const upstream = scriptBody(html, "upstream-series");
    expect(upstream).toContain('"tavily":4');
    expect(upstream).toContain('"exa":0');

    // 图表脚本与公共 layout 外壳（拆分后页面仍走 layout）
    expect(html).toContain("chart.umd.min.js");
    expect(html).toContain('src="/dashboard.js"');
    expect(html).toContain("htmx.org@1.9.12");
    expect(html).toContain('src="/admin.js"');

    // 导航高亮 dashboard
    expect(html).toContain('nav-item active" href="/admin"');
  });
});