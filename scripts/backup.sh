#!/usr/bin/env bash
# 备份 Harness Platform 数据（DB + 用户工作目录）
# 用法：
#   ./scripts/backup.sh                    # 备份到当前目录
#   ./scripts/backup.sh /path/to/backups   # 备份到指定目录
#   ./scripts/backup.sh && ./scripts/restore.sh /path/to/file.tgz   # 完整备份还原

set -euo pipefail

REPO_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
BACKUP_DIR="${1:-$(pwd)}"
TIMESTAMP=$(date +%Y%m%d_%H%M%S)
BACKUP_FILE="$BACKUP_DIR/harness-$TIMESTAMP.tgz"

mkdir -p "$BACKUP_DIR"

echo "📦 备份 harness_data 卷 → $BACKUP_FILE"
docker run --rm \
  -v harness_data:/data:ro \
  -v "$BACKUP_DIR":/backup \
  alpine sh -c "tar czf /backup/$(basename "$BACKUP_FILE") /data"

echo "✅ 完成：$BACKUP_FILE ($(du -h "$BACKUP_FILE" | cut -f1))"
echo "还原：./scripts/restore.sh $BACKUP_FILE"