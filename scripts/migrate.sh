#!/usr/bin/env bash
# 应用全部 pending 迁移并断言无残留。用法：scripts/migrate.sh [local|remote]（默认 remote）
# 依赖 wrangler.toml 显式钉住的 migrations_dir / migrations_pattern / migrations_table；
# scripts/deploy.sh 会在 wrangler deploy 前调用本脚本的 remote 形态，保证承载新代码的表结构先就位。
set -euo pipefail
cd "$(dirname "$0")/.."

target="${1:-remote}"
flag="--remote"; [[ "$target" == "local" ]] && flag="--local"

# 解析 wrangler：优先仓库本地 node_modules/.bin（直接从裸 shell 调用时 PATH 可能不含），回退 PATH。
if [[ -x "./node_modules/.bin/wrangler" ]]; then
  WRANGLER="./node_modules/.bin/wrangler"
else
  WRANGLER="wrangler"
fi

"$WRANGLER" d1 migrations apply search-proxy "$flag"

# 断言：apply 之后不应再有 pending（有残留 = 某条迁移失败，必须人工介入）。
# wrangler `migrations list` 对未应用迁移在该行渲染 "pending" 状态；无 pending 即无该字样。
if "$WRANGLER" d1 migrations list search-proxy "$flag" 2>/dev/null | grep -qi "pending"; then
  echo "❌ 仍有未应用的迁移，请检查上面的输出" >&2
  exit 1
fi
echo "✅ 数据库已到最新版本"
