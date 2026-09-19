// 领域服务·ClassifyService：上游状态码 → 重试分类族（无状态纯函数，零 IO）。
// 编号→族映射见各 provider 描述符 `statusClassMap`/`statusClassFallback`；
// FSM 动作仍按族（事件 kind）驱动，此处只做一次查找，不含任何业务分支。

import type { RetryClass } from "../domain";
import type { ProviderConfig } from "../providers";

/** 分类语义：未列出的状态码一律落描述符声明的兜底族（当前 Tavily/Exa 均为 server-error）。 */
export function classifyStatus(def: ProviderConfig, status: number): RetryClass {
  return def.statusClassMap?.[status] ?? def.statusClassFallback;
}
