// Tavily Keys 管理页：provider 专属文案/路径配置；布局与行为在 upstream-keys.tsx 共享。

import type { Child } from "hono/jsx";
import { CoreKey, Stats } from "../domain";
import { Pagination } from "./index";
import {
  UpstreamKeysViewConfig,
  upstreamKeysPage,
  upstreamListFragment,
} from "./upstream-keys";

const TAVILY_VIEW: UpstreamKeysViewConfig = {
  label: "Tavily",
  docTitle: "Tavily Keys · Tavily Proxy",
  pageTitle: "Tavily Keys",
  description: "管理上游 Tavily 官方 key · 列表始终脱敏",
  keyPlaceholder: "tvly-xxx",
  errorsNote: "当日成功/失败为上游调用尝试次数，UTC 00:00 起；429 与 400/404/422 不记。",
  listId: "tavily-list",
  basePath: "/admin/tavily",
  active: "tavily",
  emptyMessage: "暂无 Tavily key，请先添加。",
  deleteConfirm: "确认删除该 Tavily key？",
};

export function tavilyPage(csrf: string, fragment: Child) {
  return upstreamKeysPage(TAVILY_VIEW, csrf, fragment);
}

export function tavilyListFragment(
  keys: CoreKey[],
  statsMap: Record<string, Stats>,
  csrf: string,
  now: number,
  pagination: Pagination,
  flash?: string,
  total: number | null = null
) {
  return upstreamListFragment(
    TAVILY_VIEW,
    keys,
    statsMap,
    csrf,
    now,
    pagination,
    flash,
    total
  );
}
