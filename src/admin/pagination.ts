// 管理页 key 列表的 keyset 分页：仅处理 HTTP query 参数与 cursor 编解码，不访问 D1。
// Tavily/Exa 两个上游 Key 管理页与分发 Keys 管理页共享同一份参数规则、页大小、排序与游标语义。

import type { Context } from "hono";
import type { Env, AppVariables } from "../types";
import type { Pagination, PaginationLink } from "../views";

/** 固定页大小；不支持客户端自定义 limit，避免放大 D1 查询与 HTML 响应。 */
export const PAGE_SIZE = 20;

/** 通用 keyset 游标：稳定排序/边界键 (createdAt, id) 的镜像（createdAt 相同由 id 决胜）。 */
export interface PageCursor {
  createdAt: number;
  id: string;
}

export type PageQuery =
  | {
      ok: true;
      page: number;
      after: PageCursor | null;
      before: PageCursor | null;
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
export function parsePageQuery(
  c: Context<{ Bindings: Env; Variables: AppVariables }>
): PageQuery {
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
  const after = afterPresent ? decodeCursor(q["after"]!) : null;
  if (afterPresent && after === null) {
    return { ok: false, message: "无效的 after 游标" };
  }
  const before = beforePresent ? decodeCursor(q["before"]!) : null;
  if (beforePresent && before === null) {
    return { ok: false, message: "无效的 before 游标" };
  }
  if (page === 1 && (afterPresent || beforePresent)) {
    return { ok: false, message: "第一页不允许携带游标" };
  }

  return { ok: true, page, after, before };
}

/** cursor -> base64url(JSON {createdAt,id})：去 =、+ -> -、/ -> _。只含排序键，不含真实 key。 */
export function encodeCursor(cursor: PageCursor): string {
  const json = JSON.stringify({ createdAt: cursor.createdAt, id: cursor.id });
  return btoa(json).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/g, "");
}

/** base64url -> cursor；解码失败/结构不符返回 null（由解析器转 400）。 */
export function decodeCursor(value: string): PageCursor | null {
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
export function buildPagination(
  basePath: string,
  page: number,
  res: PagePayload
): Pagination {
  const cursorLink = (
    dir: "after" | "before",
    targetPage: number,
    cursor: PageCursor
  ): PaginationLink => {
    const encoded = encodeCursor(cursor);
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

export interface PagePayload {
  hasPrevious: boolean;
  hasNext: boolean;
  previousCursor: PageCursor | null;
  nextCursor: PageCursor | null;
}

/** 构建当前页自引用 query（给行内 toggle/delete 表单的 `back` 隐藏字段，保持当前页）。 */
export function buildSelfQuery(
  page: number,
  after: PageCursor | null,
  before: PageCursor | null
): string {
  if (page === 1) return "?page=1";
  const dir = after !== null ? "after" : "before";
  const cursor = after ?? before;
  return `?page=${page}&${dir}=${encodeCursor(cursor!)}`;
}
