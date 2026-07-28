#!/usr/bin/env bash
# 开发环境快速启动脚本

set -e

echo "=== FileStation 开发环境启动 ==="

# 检查 Node.js
if ! command -v node &> /dev/null; then
    echo "错误: 未找到 Node.js，请先安装 Node.js 20+"
    exit 1
fi

NODE_VERSION=$(node -v | cut -d'v' -f2 | cut -d'.' -f1)
if [ "$NODE_VERSION" -lt 20 ]; then
    echo "错误: Node.js 版本过低，需要 20+，当前: $(node -v)"
    exit 1
fi

echo "Node.js 版本: $(node -v)"

# 安装依赖
echo ""
echo "=== 安装依赖 ==="
npm install

# 创建数据目录
echo ""
echo "=== 创建数据目录 ==="
mkdir -p data/storage data/temp

# 启动开发服务器
echo ""
echo "=== 启动开发服务器 ==="
echo "后端: http://localhost:8080"
echo "前端: http://localhost:5173"
echo ""
echo "按 Ctrl+C 停止"

npm run dev
