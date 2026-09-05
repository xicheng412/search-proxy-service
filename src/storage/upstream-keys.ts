// 基础设施层·UpstreamKey 聚合持久化（D1 upstream_keys / breaker_state）。
// 同一聚合（provider 维度的上游 key 池）的两张表在此收口：
//   - upstream_keys：key / name / status / cooldown_until（key 生命周期）
//   - breaker_state：连续失败计数（consecutive），id 即上游 key id（1:1，无独立生命周期）
// cooldown_until 与计数由 applyBreakerOutcome 同批原子更新。
// 基础配置（breaker_config/queue_config）与登录会话仍留 KV，不在本层。
// 本层不吞错；"写失败是否静默、何时写"由上层策略决定。
// 所有函数以 env: Env 为句柄（同时携带 KV 与 DB），实体走 DB，配置/会话走 KV。

import type { Env } from "../types";
import {
  CoreKey,
  KeyStatus,
  UpstreamDef,
  newUpstreamId,
} from "../domain";
import { buildSetClause } from "./patch";

function toCoreKey(r: Record<string, unknown>): CoreKey {
  return {
    id: r.id as string,
    key: r.key as string,
    name: r.name as string,
    status: r.status as KeyStatus,
    cooldown_until: r.cooldown_until as number | null,
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
    "SELECT id, key, name, status, cooldown_until, created_at FROM upstream_keys WHERE provider = ?1 ORDER BY created_at"
  ).bind(def.provider).all();
  return (results as Record<string, unknown>[]).map(toCoreKey);
}

/** 按 provider + id 单行读取（管理页 name/toggle 用，避免为一条 key 拉全量列表）。 */
export async function getUpstreamKey(
  env: Env,
  def: UpstreamDef,
  id: string
): Promise<CoreKey | null> {
  const row = await env.DB.prepare(
    "SELECT id, key, name, status, cooldown_until, created_at FROM upstream_keys WHERE provider = ?1 AND id = ?2"
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
    ? `SELECT id, key, name, status, cooldown_until, created_at
       FROM upstream_keys
       WHERE provider = ?1 AND (created_at, id) < (?2, ?3)
       ORDER BY created_at DESC, id DESC
       LIMIT ?4`
    : after !== null
      ? `SELECT id, key, name, status, cooldown_until, created_at
         FROM upstream_keys
         WHERE provider = ?1 AND (created_at, id) > (?2, ?3)
         ORDER BY created_at ASC, id ASC
         LIMIT ?4`
      : `SELECT id, key, name, status, cooldown_until, created_at
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

export async function addUpstreamKey(
  env: Env,
  def: UpstreamDef,
  key: string,
  name: string,
  now: number = Date.now()
): Promise<CoreKey> {
  const item: CoreKey = {
    id: newUpstreamId(def),
    key,
    name: name || "未命名",
    status: "enabled",
    cooldown_until: null,
    created_at: now,
  };
  await env.DB.prepare(
    "INSERT INTO upstream_keys(provider,id,key,name,status,cooldown_until,created_at) VALUES(?1,?2,?3,?4,?5,?6,?7)"
  )
    .bind(def.provider, item.id, item.key, item.name, item.status, null, item.created_at)
    .run();
  return item;
}

export async function updateUpstreamKey(
  env: Env,
  def: UpstreamDef,
  id: string,
  patch: Partial<Pick<CoreKey, "name" | "status">>
): Promise<CoreKey | null> {
  const { sets, binds } = buildSetClause(patch, ["name", "status"], 1);
  if (sets.length === 0) return listUpstreamKeys(env, def).then((ks) => ks.find((k) => k.id === id) ?? null);
  const whereIdx = binds.length + 1;
  const sql =
    `UPDATE upstream_keys SET ${sets.join(", ")} WHERE provider = ?${whereIdx} AND id = ?${whereIdx + 1} RETURNING id, key, name, status, cooldown_until, created_at`;
  const row = await env.DB.prepare(sql).bind(...binds, def.provider, id).first();
  return row ? toCoreKey(row as Record<string, unknown>) : null;
}

export async function setUpstreamCooldown(
  env: Env,
  def: UpstreamDef,
  id: string,
  cooldown_until: number | null
): Promise<CoreKey | null> {
  const row = await env.DB.prepare(
    "UPDATE upstream_keys SET cooldown_until = ?1 WHERE provider = ?2 AND id = ?3 RETURNING id, key, name, status, cooldown_until, created_at"
  )
    .bind(cooldown_until, def.provider, id)
    .first();
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
  return (res.meta.changes ?? 0) > 0;
}

// ---------------------------------------------------------------
// 熔断状态（breaker_state）——UpstreamKey 聚合自身状态，非独立聚合
// ---------------------------------------------------------------

/** 熔断状态行：连续失败 + 更新时间（模拟 KV 的 10min TTL 窗口）。 */
export interface BreakerState {
  consecutive: number;
  updated_at: number;
  created_at: number;
}

export async function readBreakerState(
  env: Env,
  id: string
): Promise<BreakerState | null> {
  const row = await env.DB.prepare(
    "SELECT consecutive, updated_at, created_at FROM breaker_state WHERE id = ?1"
  )
    .bind(id)
    .first();
  return row
    ? {
        consecutive: row.consecutive as number,
        updated_at: row.updated_at as number,
        created_at: row.created_at as number,
      }
    : null;
}

/** 原子批写某次上游结果的 cooldown 更新 + 可选熔断计数 UPSERT。 */
export async function applyBreakerOutcome(
  env: Env,
  def: UpstreamDef,
  id: string,
  cooldownUntil: number,
  consecutive: number | null,
  now: number,
  createdAt: number = now
): Promise<void> {
  const stmts = [
    env.DB.prepare(
      "UPDATE upstream_keys SET cooldown_until = ?1 WHERE provider = ?2 AND id = ?3"
    ).bind(cooldownUntil, def.provider, id),
  ];
  if (consecutive !== null) {
    stmts.push(
      env.DB.prepare(
        `INSERT INTO breaker_state(id,consecutive,updated_at,created_at) VALUES(?1,?2,?3,?4)
         ON CONFLICT(id) DO UPDATE SET consecutive = excluded.consecutive, updated_at = excluded.updated_at`
      ).bind(id, consecutive, now, createdAt)
    );
  }
  await env.DB.batch(stmts);
}
