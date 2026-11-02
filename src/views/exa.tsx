// Exa Keys 管理页：provider 专属文案/路径配置；布局与行为在 upstream-keys.tsx 共享。

import type { Child } from "hono/jsx";
import { CoreKey, Stats } from "../domain";
import { Pagination } from "./index";
import {
  UpstreamKeysViewConfig,
  upstreamKeysPage,
  upstreamListFragment,
} from "./upstream-keys";

const EXA_VIEW: UpstreamKeysViewConfig = {
  label: "Exa",
  docTitle: "Exa Keys · Tavily Proxy",
  pageTitle: "Exa Keys",
  description: "管理上游 Exa 官方 key · 列表始终脱敏",
  keyPlaceholder: "Exa API key",
  errorsNote: "当日成功/失败为上游调用尝试次数，UTC 00:00 起；429 与 400/404/422 不记。",
  listId: "exa-list",
  basePath: "/admin/exa",
  active: "exa",
  emptyMessage: "暂无 Exa key，请先添加。",
  deleteConfirm: "确认删除该 Exa key？",
};

export function exaPage(csrf: string, fragment: Child) {
  return upstreamKeysPage(EXA_VIEW, csrf, fragment);
}

export function exaListFragment(
  keys: CoreKey[],
  statsMap: Record<string, Stats>,
  csrf: string,
  now: number,
  pagination: Pagination,
  flash?: string,
  total: number | null = null
) {
  return upstreamListFragment(
    EXA_VIEW,
    keys,
    statsMap,
    csrf,
    now,
    pagination,
    flash,
    total
  );
}
