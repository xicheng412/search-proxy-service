#!/usr/bin/env bash
# 生产部署脚本：从 gitignored 的 config/prod.env 注入 PUBLIC_BASE_URL（--var），再 wrangler deploy。
# 注意：wrangler 的 --var 用冒号 KEY:VALUE 分隔（按 ":" split / join），不能用 "="，否则 key 会带上前缀。
# 普通配置变量不进公开仓库；文件/字段缺失时告警并无 var 部署（运行时回退 localhost）。
set -euo pipefail
cd "$(dirname "$0")/.."

extra_vars=()
if [[ -f "config/prod.env" ]]; then
  set -a
  # shellcheck disable=SC1091
  source "config/prod.env"
  set +a
  if [[ -n "${PUBLIC_BASE_URL:-}" ]]; then
    extra_vars+=(--var "PUBLIC_BASE_URL:${PUBLIC_BASE_URL}")
  else
    echo "⚠️  config/prod.env 存在但未设置 PUBLIC_BASE_URL，将不带该 var 部署（运行时回退 localhost）" >&2
  fi
else
  echo "⚠️  未找到 config/prod.env（参考 config/prod.env.example），将不带 PUBLIC_BASE_URL 部署（运行时回退 localhost）" >&2
fi

# 先迁移后部署：保证新代码依赖的表结构（0007 起 usage_counts.bucket）先于代码上库就位；
# 迁移失败（有 pending 残留）时脚本以非零退出，冒烟阻止部署。
"$(dirname "$0")/migrate.sh" remote

if ! wrangler deploy "${extra_vars[@]}"; then
  cat >&2 <<'EOF'
❌ 迁移已应用，但 Worker 部署失败。
   不要停在「新 schema + 旧代码」状态：立即修复并重新部署，或从
   `wrangler d1 time-travel info search-proxy` /
   `wrangler d1 time-travel restore search-proxy --timestamp=<RFC3339>` 恢复到本次迁移前快照。
   （0007/0008/0009 这类重建/回填迁移与旧代码不兼容，旧 isolate 的读路径会报错。）
EOF
  exit 1
fi
