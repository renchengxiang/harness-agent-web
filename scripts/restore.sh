#!/usr/bin/env bash
# 还原 Harness Platform 数据
# 用法：
#   ./scripts/restore.sh /path/to/harness-20260625_120000.tgz

set -euo pipefail

if [ $# -lt 1 ]; then
  echo "用法：$0 <backup-file.tgz>"
  exit 1
fi

BACKUP_FILE="$1"
if [ ! -f "$BACKUP_FILE" ]; then
  echo "❌ 备份文件不存在：$BACKUP_FILE"
  exit 1
fi

REPO_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$REPO_DIR"

echo "⚠️  即将用 $BACKUP_FILE 覆盖 harness_data 卷，当前所有任务/用户/数据会丢失！"
read -r -p "确认继续？(yes/no): " confirm
if [ "$confirm" != "yes" ]; then
  echo "已取消"
  exit 0
fi

echo "🛑 停止 backend 容器…"
docker compose stop backend

echo "📦 解压覆盖到 harness_data…"
docker run --rm \
  -v harness_data:/data \
  -v "$(dirname "$BACKUP_FILE")":/backup \
  alpine sh -c "rm -rf /data/* && tar xzf /backup/$(basename "$BACKUP_FILE") -C /"

echo "🚀 启动 backend…"
docker compose start backend

echo "✅ 还原完成，等待 healthy…"
for i in $(seq 1 30); do
  status=$(docker inspect --format='{{.State.Health.Status}}' harness-backend 2>/dev/null || echo "starting")
  if [ "$status" = "healthy" ]; then
    echo "✅ 后端已 healthy"
    exit 0
  fi
  sleep 2
done
echo "⚠️ 后端未在 60s 内 healthy，请运行：docker compose logs backend"