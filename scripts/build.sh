#!/usr/bin/env bash
# 构建脚本

set -e

echo "=== FileStation 构建 ==="

# 清理
echo "清理旧构建..."
rm -rf apps/server/dist apps/web/dist

# 构建共享包
echo "构建共享包..."
npm run build --workspace=packages/shared

# 构建后端
echo "构建后端..."
npm run build --workspace=apps/server

# 构建前端
echo "构建前端..."
npm run build --workspace=apps/web

echo ""
echo "=== 构建完成 ==="
echo "后端: apps/server/dist/"
echo "前端: apps/web/dist/"
