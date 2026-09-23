// 基础设施层·UpstreamKey 聚合持久化（D1 upstream_keys）。
// 本层管 upstream_keys 注册表：id/key/name/status/created_at 权威在 D1（admin 写）；
// cooldown_until 由 QueueDO 内存池（key-pool.ts KeyPool）低频 checkpoint 批量写回
// （checkpointCooldowns），内存永远更新、D1 仅备份/冷启动恢复。
// breaker_state 已停用：连续失败计数权威在 QueueDO 内存（KeyPool.breaker），不落库；
// 表结构在迁移文件里保留（迁移工具越界，仅停止读写）。
// 基础配置（breaker_config/queue_config）与登录会话仍留 KV，不在本层。
// 本层不吞错；"写失败是否静默、何时写"由上层策略决定。
// 所有函数以 env: Env 为句柄（同时携带 KV 与 DB），实体走 DB，配置/会话走 KV。

import type { Env } from "../types";
import {
  CoreKey,
  KeyStatus,
  UpstreamDef,
  CooldownCause,
  newUpstreamId,
  maskKey,
} from "../domain";
import { buildSetClause } from "./patch";

function toCoreKey(r: Record<string, unknown>): CoreKey {
  return {
    id: r.id as string,
    key: r.key as string,
    name: r.name as string,
    status: r.status as KeyStatus,
    cooldown_until: r.cooldown_until as number | null,
    suspended_cause: r.suspended_cause as CooldownCause | null,
    created_at: r.created_at as number,
  };
}

// ---------------------------------------------------------------
// 上游 keys
// ---------------------------------------------------------------

/** 分页游标：稳定排序/边界键 (created_at, id) 的镜像（created_at 相同由 id 决胜）。 */
export interface UpstreamKeyCursor {
  createdAt: number;
  id: string;
}

/** 管理页单页结果：keys 为当前页（≤ limit），方向标记与游标给出可跳转的相邻页。 */
export interface UpstreamKeyPage {
  keys: CoreKey[];
  hasPrevious: boolean;
  hasNext: boolean;
  previousCursor: UpstreamKeyCursor | null;
  nextCursor: UpstreamKeyCursor | null;
}

export async function listUpstreamKeys(
  env: Env,
  def: UpstreamDef
): Promise<CoreKey[]> {
  const { results } = await env.DB.prepare(
    "SELECT id, key, name, status, cooldown_until, suspended_cause, created_at FROM upstream_keys WHERE provider = ?1 ORDER BY created_at"
  ).bind(def.provider).all();
  return (results as Record<string, unknown>[]).map(toCoreKey);
}

/** dashboard 统计卡用：按 provider 计数 total/enabled（注册口径，不含 cooldown）。 */
export async function countUpstreamKeys(
  env: Env,
  def: UpstreamDef
): Promise<{ total: number; enabled: number }> {
  const row = await env.DB.prepare(
    `SELECT COUNT(*) AS total,
            COALESCE(SUM(CASE WHEN status = 'enabled' THEN 1 ELSE 0 END), 0) AS enabled
     FROM upstream_keys WHERE provider = ?1`
  ).bind(def.provider).first();
  return { total: Number(row?.total ?? 0), enabled: Number(row?.enabled ?? 0) };
}

// 惰性总数缓存：总量基本不变，低频读「共 N 条」，随 add/delete（总量变动）时同 isolate 立即失效，
// 跨 isolate 由 TTL 兜底（最多 60s 陈旧，用户接受「大致统计」）。按 provider 分桶。
const upstreamCountCache = new Map<string, { at: number; total: number }>();
const UPSTREAM_COUNT_TTL_MS = 60_000;

export function clearUpstreamKeyCountCache(provider?: string): void {
  if (provider) upstreamCountCache.delete(provider);
  else upstreamCountCache.clear();
}

export async function cachedUpstreamKeyCount(env: Env, def: UpstreamDef): Promise<number> {
  const now = Date.now();
  const hit = upstreamCountCache.get(def.provider);
  if (hit && now - hit.at < UPSTREAM_COUNT_TTL_MS) return hit.total;
  const r = await countUpstreamKeys(env, def);
  upstreamCountCache.set(def.provider, { at: now, total: r.total });
  return r.total;
}

/** 按 provider + id 单行读取（管理页 name/toggle 用，避免为一条 key 拉全量列表）。 */
export async function getUpstreamKey(
  env: Env,
  def: UpstreamDef,
  id: string
): Promise<CoreKey | null> {
  const row = await env.DB.prepare(
    "SELECT id, key, name, status, cooldown_until, suspended_cause, created_at FROM upstream_keys WHERE provider = ?1 AND id = ?2"
  )
    .bind(def.provider, id)
    .first();
  return row ? toCoreKey(row as Record<string, unknown>) : null;
}

/**
 * 管理页 keyset 分页读取：只服务 Tavily/Exa admin GET；固定传入 20。
 * 首页/after/before 三种 SQL 都走 (provider, created_at, id) 复合索引；
 * 排序始终为 created_at ASC, id ASC（before 页逆序读后在内存反转）。
 * LIMIT 多取一行仅用于 hasNext/hasPrevious 判断，不返回给视图。
 */
export async function listUpstreamKeysPage(
  env: Env,
  def: UpstreamDef,
  opts: {
    after: UpstreamKeyCursor | null;
    before: UpstreamKeyCursor | null;
    limit: number;
  }
): Promise<UpstreamKeyPage> {
  const { after, before, limit } = opts;
  if (after !== null && before !== null) {
    throw new Error("listUpstreamKeysPage: after 与 before 互斥");
  }
  if (!Number.isInteger(limit) || limit <= 0) {
    throw new Error("listUpstreamKeysPage: limit 必须为正整数");
  }
  const fetchLimit = limit + 1;

  // before：逆序取上游行，内存反转回升序；after/首页：升序取。
  const goingBack = before !== null;
  const sql = goingBack
    ? `SELECT id, key, name, status, cooldown_until, suspended_cause, created_at
       FROM upstream_keys
       WHERE provider = ?1 AND (created_at, id) < (?2, ?3)
       ORDER BY created_at DESC, id DESC
       LIMIT ?4`
    : after !== null
      ? `SELECT id, key, name, status, cooldown_until, suspended_cause, created_at
         FROM upstream_keys
         WHERE provider = ?1 AND (created_at, id) > (?2, ?3)
         ORDER BY created_at ASC, id ASC
         LIMIT ?4`
      : `SELECT id, key, name, status, cooldown_until, suspended_cause, created_at
         FROM upstream_keys
         WHERE provider = ?1
         ORDER BY created_at ASC, id ASC
         LIMIT ?2`;
  const binds: unknown[] = goingBack
    ? [def.provider, before.createdAt, before.id, fetchLimit]
    : after !== null
      ? [def.provider, after.createdAt, after.id, fetchLimit]
      : [def.provider, fetchLimit];
  const { results } = await env.DB.prepare(sql).bind(...binds).all();
  const raw = results as Record<string, unknown>[];
  const pageRows = goingBack ? raw.slice(0, limit).reverse() : raw.slice(0, limit);
  const hasNextPage = goingBack ? true : raw.length > limit;
  const hasPreviousPage = goingBack ? raw.length > limit : after !== null;

  if (pageRows.length === 0) {
    // 空表/游标无结果：不抛错，两个方向都标记为 false，视图保留"首页"恢复链接。
    return {
      keys: [],
      hasPrevious: false,
      hasNext: false,
      previousCursor: null,
      nextCursor: null,
    };
  }
  const cursorOf = (r: Record<string, unknown>): UpstreamKeyCursor => ({
    createdAt: r.created_at as number,
    id: r.id as string,
  });
  return {
    keys: pageRows.map(toCoreKey),
    hasPrevious: hasPreviousPage,
    hasNext: hasNextPage,
    previousCursor: hasPreviousPage ? cursorOf(pageRows[0]) : null,
    nextCursor: hasNextPage ? cursorOf(pageRows[pageRows.length - 1]) : null,
  };
}

/** 构造新增上游 key 的 CoreKey 领域实体（单加与批量共用）。状态恒 enabled、无冷却。 */
function newUpstreamItem(def: UpstreamDef, key: string, name: string, now: number): CoreKey {
  return {
    id: newUpstreamId(def),
    key,
    name: name || "未命名",
    status: "enabled",
    cooldown_until: null,
    suspended_cause: null,
    created_at: now,
  };
}

export async function addUpstreamKey(
  env: Env,
  def: UpstreamDef,
  key: string,
  name: string,
  now: number = Date.now()
): Promise<CoreKey> {
  const item = newUpstreamItem(def, key, name, now);
  await env.DB.prepare(
    "INSERT INTO upstream_keys(provider,id,key,name,status,cooldown_until,suspended_cause,created_at) VALUES(?1,?2,?3,?4,?5,?6,?7,?8)"
  )
    .bind(def.provider, item.id, item.key, item.name, item.status, item.cooldown_until, item.suspended_cause, item.created_at)
    .run();
  clearUpstreamKeyCountCache(def.provider);
  return item;
}

export async function updateUpstreamKey(
  env: Env,
  def: UpstreamDef,
  id: string,
  patch: Partial<Pick<CoreKey, "name" | "status" | "cooldown_until" | "suspended_cause">>
): Promise<CoreKey | null> {
  const { sets, binds } = buildSetClause(patch, ["name", "status", "cooldown_until", "suspended_cause"], 1);
  if (sets.length === 0) return getUpstreamKey(env, def, id);
  const whereIdx = binds.length + 1;
  const sql =
    `UPDATE upstream_keys SET ${sets.join(", ")} WHERE provider = ?${whereIdx} AND id = ?${whereIdx + 1} RETURNING id, key, name, status, cooldown_until, suspended_cause, created_at`;
  const row = await env.DB.prepare(sql).bind(...binds, def.provider, id).first();
  return row ? toCoreKey(row as Record<string, unknown>) : null;
}

export async function deleteUpstreamKey(
  env: Env,
  def: UpstreamDef,
  id: string
): Promise<boolean> {
  const res = await env.DB.prepare(
    "DELETE FROM upstream_keys WHERE provider = ?1 AND id = ?2"
  )
    .bind(def.provider, id)
    .run();
  clearUpstreamKeyCountCache(def.provider);
  return (res.meta.changes ?? 0) > 0;
}

// ---------------------------------------------------------------
// 批量操作（batch-toggle / batch-delete 共用）
//   存在性预查 = 一并查出缺失 id（"整批拒绝"唯一前置，状态不参与前提）。
//   批量翻转/删除 = 各自单条 SQL 原子执行（SQLite 一条 statement 一个事务）。
//   缺空数组一律无操作，不碰 D1。
// ---------------------------------------------------------------

/**
 * 批量存在性预查：返回缺失的 id 列表（batch-toggle/delete 的整批拒绝前置）。
 * 非空即视为提交的 id 已被并发删除/不存在，调用方应整批拒绝、不落任何写。
 */
export async function missingUpstreamKeyIds(
  env: Env,
  def: UpstreamDef,
  ids: string[]
): Promise<string[]> {
  if (ids.length === 0) return [];
  const placeholders = ids.map((_, i) => `?${i + 2}`).join(", ");
  const { results } = await env.DB.prepare(
    `SELECT id FROM upstream_keys WHERE provider = ?1 AND id IN (${placeholders})`
  )
    .bind(def.provider, ...ids)
    .all();
  const found = new Set((results as Record<string, unknown>[]).map((r) => r.id as string));
  return ids.filter((id) => !found.has(id));
}

/**
 * 批量翻转 status（enabled↔disabled）+ 条件清冷却——单条 UPDATE。
 * 翻转语义（勿当定向 SET）：目标状态按旧行 status 反推；旧 enabled→disabled 保留冷却，
 * 旧 disabled→enabled 清 cooldown_until/suspended_cause（与单行启用路径一致）。
 * 返回受影响行数；翻成 enabled 的行需调用方在库外 activate（清内存冷却），随后 sync。
 */
export async function toggleUpstreamKeysBatch(
  env: Env,
  def: UpstreamDef,
  ids: string[]
): Promise<number> {
  if (ids.length === 0) return 0;
  const placeholders = ids.map((_, i) => `?${i + 2}`).join(", ");
  const sql =
    `UPDATE upstream_keys
     SET status = CASE WHEN status = 'enabled' THEN 'disabled' ELSE 'enabled' END,
         cooldown_until  = CASE WHEN status = 'enabled' THEN cooldown_until  ELSE NULL END,
         suspended_cause = CASE WHEN status = 'enabled' THEN suspended_cause ELSE NULL END
     WHERE provider = ?1 AND id IN (${placeholders})`;
  const res = await env.DB.prepare(sql).bind(def.provider, ...ids).run();
  clearUpstreamKeyCountCache(def.provider);
  return res.meta.changes ?? 0;
}

/** 批量删除——单条 DELETE。返回受影响行数；调用方负责 key-pool sync。 */
export async function deleteUpstreamKeysBatch(
  env: Env,
  def: UpstreamDef,
  ids: string[]
): Promise<number> {
  if (ids.length === 0) return 0;
  const placeholders = ids.map((_, i) => `?${i + 2}`).join(", ");
  const sql = `DELETE FROM upstream_keys WHERE provider = ?1 AND id IN (${placeholders})`;
  const res = await env.DB.prepare(sql).bind(def.provider, ...ids).run();
  clearUpstreamKeyCountCache(def.provider);
  return res.meta.changes ?? 0;
}


// ---------------------------------------------------------------
// 冷却批量 checkpoint——QueueDO 内存池低频写回 cooldown_until
// ---------------------------------------------------------------

export interface CooldownEntry {
  id: string;
  cooldown_until: number | null;
  suspended_cause: CooldownCause | null;
}

/** 批量写回冷却（checkpoint 用）：一次 DB.batch，写 cooldown_until + suspended_cause 两列。 */
export async function checkpointCooldowns(
  env: Env,
  def: UpstreamDef,
  entries: CooldownEntry[]
): Promise<void> {
  if (entries.length === 0) return;
  const stmts = entries.map((e) =>
    env.DB.prepare(
      "UPDATE upstream_keys SET cooldown_until = ?1, suspended_cause = ?2 WHERE provider = ?3 AND id = ?4"
    ).bind(e.cooldown_until, e.suspended_cause, def.provider, e.id)
  );
  await env.DB.batch(stmts);
}

// ---------------------------------------------------------------
// 防重/批量添加——写入期软去重（不建唯一索引，key 天然唯一）
// ---------------------------------------------------------------

/** 该 provider 下 key 是否已存在（写期软去重用；key 列天然唯一，无需唯一索引）。 */
export async function keyValueExists(
  env: Env,
  def: UpstreamDef,
  key: string
): Promise<boolean> {
  const row = await env.DB.prepare(
    "SELECT 1 FROM upstream_keys WHERE provider = ?1 AND key = ?2 LIMIT 1"
  ).bind(def.provider, key).first();
  return !!row;
}

/** 批量添加的逐行反馈：added=成功新增；duplicates=因已在库而跳过（index 为 1 起始输入行号）。 */
export interface UpstreamBatchResult {
  added: CoreKey[];
  duplicates: { index: number; key: string; maskedKey: string; name: string }[];
}

/**
 * 批量添加上游 keys（写入期软去重）：逐行查重，重复行跳过并反馈行号；非重复行批量 INSERT。
 * 空 entries 直接返回空结果（不执行 batch）。name 生成逻辑由调用方（admin 路由）预置。
 */
export async function addUpstreamKeysBatch(
  env: Env,
  def: UpstreamDef,
  entries: { key: string; name: string }[],
  now: number = Date.now()
): Promise<UpstreamBatchResult> {
  const added: CoreKey[] = [];
  const duplicates: UpstreamBatchResult["duplicates"] = [];
  const insertStmts: D1PreparedStatement[] = [];
  for (let i = 0; i < entries.length; i++) {
    const e = entries[i];
    if (await keyValueExists(env, def, e.key)) {
      duplicates.push({ index: i + 1, key: e.key, maskedKey: maskKey(e.key), name: e.name });
    } else {
      const item = newUpstreamItem(def, e.key, e.name, now);
      added.push(item);
      insertStmts.push(
        env.DB.prepare(
          "INSERT INTO upstream_keys(provider,id,key,name,status,cooldown_until,suspended_cause,created_at) VALUES(?1,?2,?3,?4,?5,?6,?7,?8)"
        ).bind(def.provider, item.id, item.key, item.name, item.status, item.cooldown_until, item.suspended_cause, item.created_at)
      );
    }
  }
  if (insertStmts.length > 0) {
    await env.DB.batch(insertStmts);
    clearUpstreamKeyCountCache(def.provider);
  }
  return { added, duplicates };
}
