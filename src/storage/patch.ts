// 基础设施层·存储共享工具（非领域）：
// 为 `UPDATE ... SET col = ?N` 动态子句构建占位符与绑定。
// updateUpstreamKey / updateDistributedKey 共用同一套"列白名单 + ?N 递推"机制，
// 与原两处各自内联的 if 块行为完全一致：列按声明顺序，undefined 跳过，编号随 binds 递增。

export interface SetClause {
  sets: string[];
  binds: unknown[];
}

/**
 * 从 patch 中提取非 undefined 列，构建 `col = ?N` 片段与对应 binds。
 * columns 为可更新列白名单（固定顺序保证 ?N 编号稳定）；调用方需保持列序不变。
 * nextIndex 为本次 SET 片段使用的第一个占位符编号（调用方沿用自身绑定起始值 1）。
 */
export function buildSetClause(
  patch: Record<string, unknown>,
  columns: readonly string[],
  nextIndex: number
): SetClause {
  const sets: string[] = [];
  const binds: unknown[] = [];
  for (const col of columns) {
    const value = patch[col];
    if (value !== undefined) {
      sets.push(`${col} = ?${nextIndex + binds.length}`);
      binds.push(value);
    }
  }
  return { sets, binds };
}
