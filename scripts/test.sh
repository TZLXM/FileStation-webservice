#!/usr/bin/env bash
# 测试脚本

set -e

echo "=== FileStation 测试 ==="

# 类型检查
echo "1. 类型检查..."
npm run typecheck

# Lint
echo ""
echo "2. Lint..."
npm run lint

# 单元测试
echo ""
echo "3. 单元测试..."
npm test

echo ""
echo "=== 所有测试通过 ==="
