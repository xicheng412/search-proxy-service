// Provider 聚合层：定义引擎里"一个上游 provider"的全部事实，并汇总注册表。
// 共享泛型代码（kv/proxy/admin/views）只消费 ProviderConfig / PROVIDERS，
// 因此新增 provider 时只需加一个描述符文件并在本文件注册，无需改任何逻辑文件。

import { Capability, Provider, UpstreamDef, WireProtocol } from "../domain";
import { TAVILY } from "./tavily";
import { EXA } from "./exa";

/** 能力在某 provider 上的上游落地：上游 path + 该能力在此开放的线协议。 */
export interface Surface {
  path: string;              // 上游端点路径（能力→上游 path 映射）
  protocols: WireProtocol[]; // 该能力在此 provider 上开放的线协议
}

export interface ProviderConfig<P extends Provider = Provider> {
  name: P;
  base: string;                       // 上游 API base，如 https://api.exa.ai
  capabilities: Partial<Record<Capability, Surface>>; // 能力→上游落地；未声明的能力对该 provider 不可用（→404）
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
