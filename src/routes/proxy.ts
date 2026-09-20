// 代理数据面子应用：承载 /search /extract /reader 三个数据面端点。
// cors + authenticate 必须按端点挂载，而非 use("*")：Hono 会把挂根 sub-app 的
// use("*") 扁平化到根路由（全局生效），authenticate 会拦下无 token 的 / 与 /admin/*，
// cors 也会给非数据面端点加头。按端点收口后：cors 只作用于数据面端点（/、/help、/admin/*
// 不再带 CORS 头，为预期收敛）、authenticate 只在数据面端点做准入（成功注入 c.var.auth）。

import { Hono } from "hono";
import { cors } from "hono/cors";
import type { Env, AppVariables } from "../types";
import { authenticate } from "../proxy/authenticate";
import { countDist } from "../proxy/count-dist";
import { handleSearch } from "../proxy/handlers/search";
import { handleExtract } from "../proxy/handlers/extract";
import { handleReader } from "../proxy/handlers/reader";

export const proxyApp = new Hono<{ Bindings: Env; Variables: AppVariables }>();

// - /search 承载 Search 能力（POST native 透传 Bearer <tavily|exa>-<key>；GET|POST searxng Bearer searxng-tavily-<key>）。
// - /extract 承载 Extract 能力（POST native 透传 Bearer tavily-<key>）；无 searxng 语义、exa 无此能力。
// - /reader 承载 Extract 能力（GET reader 协议 Bearer reader-tavily-<key>，URL→文本）。
// 中间件顺序：cors（浏览器跨域，鉴权靠请求头里的分发 key）→ authenticate（数据面准入）→
// countDist（dist 请求到达 +1，主 Worker 直记）→ handler。401 在 authenticate 短路，不达 countDist。
proxyApp.all("/search", cors(), authenticate, countDist, handleSearch);
proxyApp.post("/extract", cors(), authenticate, countDist, handleExtract);
proxyApp.get("/reader/*", cors(), authenticate, countDist, handleReader);
