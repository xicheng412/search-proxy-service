// 公开静态页子应用：/（门户总览文本）与 /help（使用说明页）。无需登录、相对 admin 独立。

import { Hono } from "hono";
import type { Env } from "../types";
import { resolvePublicBaseUrl } from "../config";
import { helpPage } from "../views/help";

export const publicApp = new Hono<{ Bindings: Env }>();

publicApp.get("/", (c) => {
  return c.text(
`Tavily / Exa API 密钥代理服务

本服务是一个中间代理：上游真实 key（Tavily / Exa 官方 key）收口在本服务，
向外只签发可独立管控的分发 key。调用时用
Authorization: Bearer <前缀>-<key>   前缀选 provider、端点选能力。

访问入口：
- /help           使用说明（curl 示例、调用前缀、错误表）——公开，无需登录
- /admin          管理后台（上游 key / 分发 key / 统计）——需管理员登录
- /search         搜索（Search 能力）：POST native（Bearer tavily-<key>|exa-<key>）
                    或 GET|POST searxng（Bearer searxng-tavily-<key>）
- /extract        提取（Extract 能力，仅 Tavily）：POST native（Bearer tavily-<key>）
- /reader/<url>   页面正文（Extract 能力，reader 协议）：GET（Bearer reader-tavily-<key>）

继续操作：想知道怎么调用 → 访问 /help；想管理 key / 看统计 → 访问 /admin。`
  );
});

// 公开使用说明页：独立于管理后台（自带样式，无 admin 依赖），无需登录；admin 顶栏「使用说明」新标签打开。
publicApp.get("/help", (c) => c.html(helpPage(resolvePublicBaseUrl(c.env))));
