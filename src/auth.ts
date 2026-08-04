// 管理员认证模块：密码登录、KV 会话、CSRF 防护、登出。

import { Context, MiddlewareHandler } from "hono";
import { getCookie, setCookie, deleteCookie } from "hono/cookie";
import { Env, AppVariables } from "./types";
import { randomToken } from "./domain";

const SESSION_TTL_MS = 24 * 60 * 60 * 1000; // 24 小时
const SESSION_COOKIE = "admin_session";

interface Session {
  expires_at: number;
  csrf: string;
  created_at: number;
}

function sessionKey(sid: string): string {
  return `session:${sid}`;
}

export async function createSession(
  c: Context<{ Bindings: Env; Variables: AppVariables }>
): Promise<void> {
  const sid = randomToken(32);
  const now = Date.now();
  const session: Session = {
    created_at: now,
    expires_at: now + SESSION_TTL_MS,
    csrf: randomToken(24),
  };
  const kv = c.env.KV;
  await kv.put(sessionKey(sid), JSON.stringify(session), {
    expirationTtl: Math.floor(SESSION_TTL_MS / 1000),
  });
  setCookie(c, SESSION_COOKIE, sid, {
    httpOnly: true,
    sameSite: "Lax",
    path: "/",
    secure: true,
    maxAge: Math.floor(SESSION_TTL_MS / 1000),
  });
}

export async function getSession(
  c: Context<{ Bindings: Env; Variables: AppVariables }>
): Promise<Session | null> {
  const sid = getCookie(c, SESSION_COOKIE);
  if (!sid) return null;
  let session: Session | null = null;
  try {
    const raw = await c.env.KV.get(sessionKey(sid), "text");
    if (raw) session = JSON.parse(raw) as Session;
  } catch {
    session = null;
  }
  if (!session) return null;
  if (Date.now() > session.expires_at) {
    // 过期自动失效并清理
    await c.env.KV.delete(sessionKey(sid)).catch(() => {});
    return null;
  }
  return session;
}

export function getSessionSid(
  c: Context<{ Bindings: Env; Variables: AppVariables }>
): string | null {
  return getCookie(c, SESSION_COOKIE) ?? null;
}

export async function destroySession(
  c: Context<{ Bindings: Env; Variables: AppVariables }>
): Promise<void> {
  const sid = getSessionSid(c);
  if (sid) await c.env.KV.delete(sessionKey(sid)).catch(() => {});
  deleteCookie(c, SESSION_COOKIE, { path: "/" });
}

/**
 * CSRF token 随会话绑定。前端表单需以隐藏字段 csrf_token 携带，
 * 服务端在写操作时用 validateCsrf 校验。
 */
export async function getCsrfToken(
  c: Context<{ Bindings: Env; Variables: AppVariables }>
): Promise<string | null> {
  const session = await getSession(c);
  return session ? session.csrf : null;
}

export async function validateCsrf(
  c: Context<{ Bindings: Env; Variables: AppVariables }>
): Promise<boolean> {
  const session = await getSession(c);
  if (!session) return false;
  const token = (c.req.query("csrf_token") as string | undefined) ??
    (await c.req.parseBody().then((b) => (b["csrf_token"] as string) ?? null).catch(() => null));
  if (!token) return false;
  // 恒定时间比较，防时序侧信道
  const a = new TextEncoder().encode(token);
  const b = new TextEncoder().encode(session.csrf);
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a[i] ^ b[i];
  return diff === 0;
}

/** 要求已登录；未登录则对 API 返回 401，对页面返回 302 跳登录页。 */
export function requireAuth(redirectToLogin = false): MiddlewareHandler<{
  Bindings: Env;
  Variables: AppVariables;
}> {
  return async (c, next) => {
    const session = await getSession(c);
    if (!session) {
      if (redirectToLogin) {
        return c.redirect("/admin/login?next=" + encodeURIComponent(c.req.path));
      }
      return c.text("Unauthorized", 401);
    }
    c.set("admin", true);
    await next();
  };
}

/** 登录处理：POST /admin/login，校验密码。 */
export async function handleLogin(
  c: Context<{ Bindings: Env; Variables: AppVariables }>
) {
  const body = await c.req.parseBody();
  const password = (body["password"] as string) ?? "";
  if (!c.env.ADMIN_PASSWORD || password !== c.env.ADMIN_PASSWORD) {
    return c.redirect(
      "/admin/login?error=1" +
        (c.req.query("next")
          ? "&next=" + encodeURIComponent(c.req.query("next")!)
          : ""),
      302
    );
  }
  await createSession(c);
  const next = c.req.query("next") || "/admin";
  return c.redirect(next.startsWith("/") ? next : "/admin", 302);
}

/** 登出处理：POST /admin/logout，销毁会话。 */
export async function handleLogout(
  c: Context<{ Bindings: Env; Variables: AppVariables }>
) {
  await destroySession(c);
  return c.redirect("/admin/login", 302);
}
