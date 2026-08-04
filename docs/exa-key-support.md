# Exa Key 管理与透明代理 · 实施计划

> 状态：**已实施完成**（Phase 1→3 全部落地，`pnpm dev` 冒烟验证通过）。
> 已确认决策：① Phase 2 即引入分发 key 的 `provider` 字段并让 `/search` 按它路由（不写临时端点）；② 每 provider 独立 KV 数组 + 泛型 CRUD（零迁移）；③ Exa 透明代理仅暴露 `/search`；④ **文件按 provider 彻底拆分：admin 路由与 views 列表模板各一份**（公共脚手架 layout/nav/login/Dashboard 保持共享）。

## 1. 目标

1. 新增 **Exa Keys** 管理（逻辑与现有 Tavily Keys 等价）：列表/新增（可 test call）/启用停用/删除，含每日成功失败统计与熔断冷却。
2. 实现 **Exa 透明代理**：分发 key 请求 `POST /search` 时按该 key 归属的 provider（tavily/exa）路由到对应上游，`Bearer` 换成真实上游 key，结果原样透传，统计/熔断/429 切 key 重试逻辑与 Tavily 一致。
3. 分发 key 新增 **`provider` 属性**（"tavily"|"exa"），后台生成表单与列表用 **radio** 做设置与修改。

## 2. Exa 官方接口事实（已查证）

| 项 | 值 |
|---|---|
| Base URL | `https://api.exa.ai` |
| 鉴权 | `Authorization: Bearer <key>`（与 Tavily 同构，Bearer 替换可复用） |
| 端点 | `POST /search`（本计划仅暴露此端点） |
| 错误体 | 非 429：`{ requestId?, error, tag }`；429：`{ error: "..." }` —— **与 Tavily 的 `{detail:{error}}` 不同，必须按 provider 区分** |
| key 格式 | 官方未公开前缀/长度 → 不做前缀校验，`maskKey` 通用 |

## 3. 数据模型

```ts
export type Provider = "tavily" | "exa";
export type KeyStatus = "enabled" | "disabled";

export interface CoreKey {
  id: string;                 // tavily: tk_*, exa: ek_*
  key: string;
  name: string;
  status: KeyStatus;
  cooldown_until: number | null;
  created_at: number;
}
export type TavilyKey = CoreKey;
export type ExaKey = CoreKey;

export interface DistributedKey {
  api_key: string;
  note: string;
  provider: Provider;         // 新增；旧数据读取时默认 "tavily"
  status: KeyStatus;
  created_at: number;
  plain_viewed: boolean;
}
```

## 4. 文件结构（已确认：按 provider 拆分）

```
src/
  index.ts            # 入口；/ 健康检查；/search 先鉴权取 provider → 路由；登录/登出；挂 admin
  types.ts            # Env / AppVariables（不变）
  auth.ts             # 会话 / CSRF（不变）
  kv.ts               # 泛型数据层（零 provider 分支）：CoreKey / DistributedKey / CRUD / 统计 / 熔断 /
                      #   maskKey / randomToken / todayDate；UpstreamDef 描述符驱动取 keysKey、idPrefix
  providers/
    index.ts          # ProviderConfig 接口 + PROVIDERS 注册表 + errorBody 工具
    tavily.ts         # Tavily 描述符：keysKey、id 前缀、base、endpoints、错误体、test 体、后台路径/标签
    exa.ts            # Exa 描述符（同构）
  proxy.ts            # 泛型代理 handleProviderProxy(c, def, path, apiKey)：加权随机 / 429 切 key /
                      #   熔断 / 分类统计 / 透传 —— 一套算法，def 驱动，无 provider 分支
  admin/
    index.ts          # 后台根路由：auth 中间件 + Dashboard 总览 + 挂载 tavily/exa/keys
    tavily.ts         # /admin/tavily/* 处理器（page/list/add/toggle/delete，test call 打 Tavily）
    exa.ts            # /admin/exa/* 处理器（同构，test call 打 Exa）
    keys.ts           # /admin/keys/* 分发 key（生成带 provider radio、查看明文、toggle、delete、改 provider）
  views/
    index.ts          # 公共脚手架：layout / nav / loginPage / adminPage(Dashboard) / csrfField /
                      #   errorFragment / distListFragment(含 provider radio)
    tavily.ts         # tavilyPage / tavilyListFragment / tavilyAddResult（复制一份，自有路径/文案）
    exa.ts            # exaPage / exaListFragment / exaAddResult（复制一份）
```

**拆分原则**
- `providers/tavily.ts` 与 `providers/exa.ts` 各聚合本 provider 全部事实；看某 provider 只进一个目录的对应文件。
- 共享泛型：`kv.ts`（数据）、`proxy.ts`（代理算法）、`views/index.ts`（公共 UI 与分发 key）、`admin/index.ts`（中间件/Dashboard）、`admin/keys.ts`。
- provider 特有：`admin/tavily.ts`、`admin/exa.ts`、`views/tavily.ts`、`views/exa.ts`、`providers/tavily.ts`、`providers/exa.ts`。
- 全代码库零 `if provider === ...` 分支（除分发 key 路由取值与描述符查表）。

### 4.1 Provider 描述符（`providers/*.ts` 导出，定义见 `providers/index.ts`）

```ts
export interface ProviderConfig {
  name: Provider;
  base: string;                       // https://api.tavily.com | https://api.exa.ai
  endpoints: { search: string };      // "/search"
  upstreamDef: {                       // 交由 kv.ts 泛型 CRUD 使用
    keysKey: string;                   // "tavily_keys" | "exa_keys"
    idPrefix: string;                  // "tk_" | "ek_"
  };
  admin: { basePath: string; label: string };   // "/admin/tavily" | "/admin/exa"
  testBody(): Record<string, unknown>;
  errorBody(status: number, message: string): Response;
}
export const PROVIDERS: Record<Provider, ProviderConfig>;
```

- Tavily `errorBody` → `{detail:{error}}`；Exa `errorBody` → `{error}`。

### 4.2 代理（`proxy.ts`）

`handleProviderProxy(c, def, path, apiKey)`：校验分发 key（上层已鉴权）→ 取该 provider 的可用上游 key → 加权随机（权重 `1/(fail+1)`，排除 disabled/冷却）→ 无可用 503（`def.errorBody`）→ 转发 `def.base + path`、Bearer 换真实 key → 429 切同 provider 另一 key 重试一次，仍 429 双计失败透传 → 2xx/其他分类计统计 + 熔断 → 原样透传（passthrough 保留）。

### 4.3 分发 key 与路由

- `generateDistributedKey(kv, note, provider, now)` 显式写 provider。
- `listDistributedKeys` 读取归一化：缺 `provider` 一律填 `"tavily"`（向后兼容）。
- `updateDistributedKey` patch 增加 `provider`。
- `POST /search`：`authenticate` 改为返回整个 DistributedKey（含 provider）；未知/无效 key 的 401 保持现 Tavily 错误体，不扰动现有 Tavily 客户端。

## 5. 分阶段实施

### Phase 1 —— Exa Keys 管理
- `kv.ts`：`CoreKey` 类型、`UpstreamDef` + 泛型 CRUD（`listUpstreamKeys(kv, def)` 等）、`newUpstreamId(def)`、统计/熔断函数更名（按 id 泛型）、`TavilyKey`/`ExaKey` 别名；调用点同步。
- `providers/`：`index.ts` 接口 + `tavily.ts` 描述符 + `exa.ts` 描述符。
- `views/`：拆出 `index.ts`（脚手架 + 分发 key）、`tavily.ts`（tavilyPage/tavilyListFragment）、`exa.ts`（exaPage/exaListFragment）；nav 增 "Exa Keys"；Dashboard 增 Exa 统计卡。
- `admin/`：拆出 `index.ts`（中间件/Dashboard）、`tavily.ts`、`exa.ts`（/admin/exa/add 的 test call 打 `api.exa.ai/search`，体重 `{query:"test"}`）。
- 验收：后台可增删/启停 Exa key、test call 校验、列表显示成功/失败/冷却；Tavily 功能与页面无回归。

### Phase 2 —— Exa 透明代理 + 分发 key provider 路由
- `proxy.ts`：`handleProviderProxy` 重构（def 驱动）；`authenticate` 返回整个分发 key；`handleSearch` 适配。
- `kv.ts`：`DistributedKey.provider`、`generateDistributedKey` 带 provider、`listDistributedKeys` 归一化、`updateDistributedKey` patch 支持 provider。
- `views/index.ts` + `admin/keys.ts`：生成表单加 radio（Tavily/Exa，默认 Tavily），`POST /keys/generate` 读 provider 写入。
- `index.ts`：`/search` 先 `authenticate` 取 provider 再 `handleProviderProxy`；根 `/` 端点描述补充。
- 验收：Exa provider 分发 key → /search 返回 Exa 结果结构；无可用 Exa key → 503（Exa 报错格式）；429 切 key；Tavily provider 分发 key 行为与现状一致。

### Phase 3 —— 分发 key provider 修改 UI
- `views/index.ts` `distListFragment`：表格增 "Provider" 列（徽标）+ 每行 radio + 保存 表单 → `POST /admin/keys/:apiKey/provider`。
- `admin/keys.ts`：新增 `POST /admin/keys/:apiKey/provider`，校验 csrf + 合法 provider。
- 验收：列表内切换分发 key provider 保存后即时生效，/search 路由随之变化。

## 6. 兼容与默认值

- 旧 `distributed_keys` 无 `provider` → 归一化 `"tavily"`，行为不变。
- 旧 `tavily_keys` 数据、统计键、熔断键结构不变 → 零迁移。
- 无效分发 key 的 401 保持现 Tavily 错误体。

## 7. 边界与风险

- Exa key 格式未公开 → 新增表单不做前缀校验（同 Tavily 现状），只做可选 test call。
- Exa /search 有内容计费 → test call 用最小体 `{query:"test"}`。
- Exa 错误体与 Tavily 不同 → 代理内 401/503/错误响应一律走 `def.errorBody`，禁止硬编码。
- views 两套列表模板按用户确认复制，注意后续布局改动需同步两处。
- CORS 已全局放行，不改动。

## 8. 验证方式（每 Phase 独立冒烟）

- Phase 1：`pnpm dev` → 登录后台 → 增删/启停 Exa key、test call、看统计冷却；Tavily 页回归。
- Phase 2：生成 Exa provider 分发 key → curl `POST /search` 验 Exa 返回；无 Exa key 验 503；429 验切 key；Tavily key 回归。
- Phase 3：列表内切 provider 保存 → 再 `POST /search` 验路由切换。
- 依赖真实 key：本地 `.dev.vars` 配 `ADMIN_PASSWORD`；上游 key 由需求方在后台填入（test call 就近验证）。

## 9. 交付物

- `docs/exa-key-support.md`（本计划）
- 新增：`src/providers/index.ts`、`src/providers/tavily.ts`、`src/providers/exa.ts`、`src/admin/tavily.ts`、`src/admin/exa.ts`、`src/admin/keys.ts`、`src/views/tavily.ts`、`src/views/exa.ts`
- 重构：`src/kv.ts`、`src/proxy.ts`、`src/admin/index.ts`、`src/views/index.ts`、`src/index.ts`
- 不改：`src/types.ts`、`src/auth.ts`
- 默认不引入新依赖。
