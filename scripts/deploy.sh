#!/usr/bin/env bash
# 生产部署脚本：从 gitignored 的 config/prod.env 注入 PUBLIC_BASE_URL（--var），再 wrangler deploy。
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
    extra_vars+=(--var "PUBLIC_BASE_URL=${PUBLIC_BASE_URL}")
  else
    echo "⚠️  config/prod.env 存在但未设置 PUBLIC_BASE_URL，将不带该 var 部署（运行时回退 localhost）" >&2
  fi
else
  echo "⚠️  未找到 config/prod.env（参考 config/prod.env.example），将不带 PUBLIC_BASE_URL 部署（运行时回退 localhost）" >&2
fi

wrangler deploy "${extra_vars[@]}"
