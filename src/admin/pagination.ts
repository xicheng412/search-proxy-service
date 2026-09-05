// 管理页上游 key 列表的 keyset 分页：仅处理 HTTP query 参数与 cursor 编解码，不访问 D1。
// Tavily/Exa 两个上游 Key 管理页共享同一份参数规则、页大小、排序与游标语义。

import type { Context } from "hono";
import type { Env, AppVariables } from "../types";
import type { UpstreamKeyCursor } from "../storage/upstream-keys";
import type { UpstreamPagination, UpstreamPaginationLink } from "../views";

/** 固定页大小；不支持客户端自定义 limit，避免放大 D1 查询与 HTML 响应。 */
export const UPSTREAM_PAGE_SIZE = 20;

export type UpstreamPageQuery =
  | {
      ok: true;
      page: number;
      after: UpstreamKeyCursor | null;
      before: UpstreamKeyCursor | null;
    }
  | { ok: false; message: string };

/**
 * 解析分页 query 参数。
 * - 缺 page 按 1；page 必须是 ≥1 的安全整数。
 * - after/before 互斥，至多一个存在。
 * - page=1 不允许携带 cursor（带 cursor 的 page 必须 >1）。
 * - cursor 必须能 base64url 解码为 {createdAt:<有限数>, id:<非空串>}。
 * 任一不满足返回 { ok:false }，由路由返回 400，不执行 D1。
 */
export function parseUpstreamPageQuery(
  c: Context<{ Bindings: Env; Variables: AppVariables }>
): UpstreamPageQuery {
  const q = c.req.query();
  const pageRaw = q["page"] ?? "1";
  const page = Number(pageRaw);
  if (!Number.isSafeInteger(page) || page < 1) {
    return { ok: false, message: "无效的页码" };
  }

  const afterPresent = q["after"] !== undefined;
  const beforePresent = q["before"] !== undefined;
  if (afterPresent && beforePresent) {
    return { ok: false, message: "after 与 before 不能同时存在" };
  }
  const after = afterPresent ? decodeUpstreamCursor(q["after"]!) : null;
  if (afterPresent && after === null) {
    return { ok: false, message: "无效的 after 游标" };
  }
  const before = beforePresent ? decodeUpstreamCursor(q["before"]!) : null;
  if (beforePresent && before === null) {
    return { ok: false, message: "无效的 before 游标" };
  }
  if (page === 1 && (afterPresent || beforePresent)) {
    return { ok: false, message: "第一页不允许携带游标" };
  }

  return { ok: true, page, after, before };
}

/** cursor -> base64url(JSON {createdAt,id})：去 =、+ -> -、/ -> _。只含排序键，不含真实 key。 */
export function encodeUpstreamCursor(cursor: UpstreamKeyCursor): string {
  const json = JSON.stringify({ createdAt: cursor.createdAt, id: cursor.id });
  return btoa(json).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/g, "");
}

/** base64url -> cursor；解码失败/结构不符返回 null（由解析器转 400）。 */
export function decodeUpstreamCursor(value: string): UpstreamKeyCursor | null {
  try {
    const b64 = value.replace(/-/g, "+").replace(/_/g, "/") + "=".repeat((4 - (value.length % 4)) % 4);
    const parsed = JSON.parse(atob(b64)) as unknown;
    if (typeof parsed !== "object" || parsed === null) return null;
    const { createdAt, id } = parsed as { createdAt?: unknown; id?: unknown };
    if (typeof createdAt !== "number" || !Number.isFinite(createdAt)) return null;
    if (typeof id !== "string" || id.length === 0) return null;
    return { createdAt, id };
  } catch {
    return null;
  }
}

/**
 * 由分页结果构造控件数据：href 面向完整页面，hxGet 面向 HTMX fragment，
 * 两者 query 参数（page/cursor）完全相同；首页 URL 不带 cursor。
 * basePath 为完整页路径（如 /admin/tavily），hxGet 即 basePath + "/list"。
 */
export function buildUpstreamPagination(
  basePath: string,
  page: number,
  res: UpstreamKeyPagePayload
): UpstreamPagination {
  const cursorLink = (
    dir: "after" | "before",
    targetPage: number,
    cursor: UpstreamKeyCursor
  ): UpstreamPaginationLink => {
    const encoded = encodeUpstreamCursor(cursor);
    const query = `?page=${targetPage}&${dir}=${encoded}`;
    return { href: `${basePath}${query}`, hxGet: `${basePath}/list${query}` };
  };
  return {
    page,
    first: { href: `${basePath}?page=1`, hxGet: `${basePath}/list?page=1` },
    previous:
      res.hasPrevious && res.previousCursor
        ? cursorLink("before", page - 1, res.previousCursor)
        : null,
    next:
      res.hasNext && res.nextCursor
        ? cursorLink("after", page + 1, res.nextCursor)
        : null,
  };
}

type UpstreamKeyPagePayload = {
  hasPrevious: boolean;
  hasNext: boolean;
  previousCursor: UpstreamKeyCursor | null;
  nextCursor: UpstreamKeyCursor | null;
};
