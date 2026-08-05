// 基础设施·对外地址配置（唯一取值位置）。
// PUBLIC_BASE_URL 是"调用方访问本服务的对外 origin"（生产经 scripts/deploy.sh 从 gitignored 的
// config/prod.env 以 --var 注入、本地 .dev.vars 覆盖），纯展示/门户数据（复制按钮、帮助页），热路径 /search 不读。
// 全站只有一个取值点：未配置或非法（非 http(s)）时按约定回退本地 localhost；按 isolate 解析一次缓存。

import type { Env } from "./types";

const DEFAULT_PUBLIC_BASE_URL = "http://localhost:8787";

let cached: string | null = null;

/** 解析对外 base url（含规范化：去尾部斜杠、保留可选路径前缀）。 */
export function resolvePublicBaseUrl(env: Env): string {
  if (cached === null) {
    const raw = (env.PUBLIC_BASE_URL ?? "").trim().replace(/\/+$/, "");
    let base = DEFAULT_PUBLIC_BASE_URL;
    try {
      const u = new URL(raw);
      if (u.protocol === "http:" || u.protocol === "https:") {
        base = u.origin + u.pathname.replace(/\/+$/, "");
      }
    } catch {
      // 未配置 / 非法值 → 默认 localhost
    }
    cached = base;
  }
  return cached;
}
