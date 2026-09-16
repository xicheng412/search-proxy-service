// 管理员认证子应用：/admin/login（页面 + POST）与 /admin/logout。无守卫——
// login 必须在 admin 会话守卫之外，否则 302 循环。挂载于 /admin，路径相对前缀。

import { Hono } from "hono";
import type { Env, AppVariables } from "../types";
import { handleLogin, handleLogout } from "../auth";
import { loginPage } from "../views/login";

export const adminAuth = new Hono<{ Bindings: Env; Variables: AppVariables }>();

adminAuth.get("/login", (c) => c.html(loginPage(c.req.query("error") === "1")));
adminAuth.post("/login", handleLogin);
adminAuth.post("/logout", handleLogout);
