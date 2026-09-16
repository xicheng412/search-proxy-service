// 管理后台鉴权中间件：会话守卫 + CSRF 收口。feature 内聚（对齐 src/proxy/authenticate.ts
// 先例），由 src/admin/index.ts 装配；isPagePath 以谓词注入，避免与装配层循环依赖。

import { MiddlewareHandler } from "hono";
import { Env, AppVariables } from "../types";
import { getSession, validateCsrf } from "../auth";
import { errorFragment } from "../views";

/** 会话守卫：页面 GET（isPagePath 判定）未登录 → 302 跳登录；其余（片段 GET/写操作）→ 401。 */
export const sessionGuard =
  (isPagePath: (p: string) => boolean): MiddlewareHandler<{ Bindings: Env; Variables: AppVariables }> =>
  async (c, next) => {
    const session = await getSession(c);
    if (!session) {
      return c.req.method === "GET" && isPagePath(c.req.path)
        ? c.redirect("/admin/login?next=" + encodeURIComponent(c.req.path))
        : c.text("Unauthorized", 401);
    }
    c.set("admin", true);
    await next();
  };

/** CSRF 收口：所有 admin POST 写操作统一校验 token；失败 errorFragment("CSRF 校验失败") 403。 */
export const csrfGuard: MiddlewareHandler<{ Bindings: Env; Variables: AppVariables }> = async (
  c,
  next
) => {
  if (c.req.method === "POST" && !(await validateCsrf(c))) {
    return c.html(errorFragment("CSRF 校验失败"), 403);
  }
  await next();
};
