// Provider 聚合层：定义引擎里"一个上游 provider"的全部事实，并汇总注册表。
// 共享泛型代码（kv/proxy/admin/views）只消费 ProviderConfig / PROVIDERS，
// 因此新增 provider 时只需加一个描述符文件并在本文件注册，无需改任何逻辑文件。

import { Provider, UpstreamDef } from "../domain";
import { TAVILY } from "./tavily";
import { EXA } from "./exa";

export interface ProviderConfig<P extends Provider = Provider> {
  name: P;
  base: string;                          // 上游 API base，如 https://api.exa.ai
  endpoints: { search: string };         // 本服务对外透明转发的端点（当前阶段的唯一端点）
  upstream: UpstreamDef;                 // KV 数组键 + id 前缀，供泛型 CRUD/统计/熔断定位
  admin: { basePath: string; label: string }; // 后台挂载路径与导航标签
  /** 新增上游 key 时的可选验证（test call）请求体 */
  testBody: () => Record<string, unknown>;
  /** 构造贴合该 provider 官方错误格式的响应（Tavily 与 Exa 格式不同） */
  errorBody: (status: number, message: string) => Response;
}

export { TAVILY } from "./tavily";
export { EXA } from "./exa";

export const PROVIDERS = { tavily: TAVILY, exa: EXA } as const;
