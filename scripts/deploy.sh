#!/usr/bin/env bash
# Harness Platform 一键部署脚本
# 用法:
#   ./scripts/deploy.sh init       # 首次部署（生成 .env、密钥、构建、启动）
#   ./scripts/deploy.sh update     # 拉取新代码并重建
#   ./scripts/deploy.sh restart    # 重启服务
#   ./scripts/deploy.sh logs       # 查看后端日志
#   ./scripts/deploy.sh status     # 查看容器状态
#   ./scripts/deploy.sh admin      # 重置管理员密码

set -euo pipefail

# ─── 配置 ──────────────────────────────────────────────
REPO_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$REPO_DIR"

COMPOSE_CMD="docker compose"

# ─── 颜色输出 ──────────────────────────────────────────
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
RED='\033[0;31m'
NC='\033[0m'

log()  { printf "${GREEN}[✓]${NC} %s\n" "$*"; }
warn() { printf "${YELLOW}[!]${NC} %s\n" "$*"; }
err()  { printf "${RED}[✗]${NC} %s\n" "$*" >&2; }

# ─── 工具函数 ──────────────────────────────────────────
require_docker() {
  if ! command -v docker >/dev/null 2>&1; then
    err "未检测到 docker，请先安装：curl -fsSL https://get.docker.com | sh"
    exit 1
  fi
  if ! docker compose version >/dev/null 2>&1; then
    err "未检测到 docker compose（v2）"
    exit 1
  fi
}

ensure_env_file() {
  if [ ! -f .env ]; then
    log "生成 .env（含强 JWT 密钥与默认管理员）…"
    JWT_SECRET=$(python3 -c 'import secrets; print(secrets.token_urlsafe(48))')
    cat > .env <<EOF
# Harness Platform 环境变量
# ⚠️ 不要把 .env 提交到 git！
HARNESS_JWT_SECRET=$JWT_SECRET
HARNESS_ADMIN_USERNAME=admin
HARNESS_ADMIN_PASSWORD=$(python3 -c 'import secrets; print(secrets.token_urlsafe(16))')

# 可选：透传 host 上的 LLM provider 凭证
# ANTHROPIC_API_KEY=
# OPENAI_API_KEY=
EOF
    log ".env 已生成（密码见上文）"
  else
    log ".env 已存在，跳过生成"
  fi

  # 校验 JWT secret 长度
  JWT_SECRET=$(grep '^HARNESS_JWT_SECRET=' .env | cut -d'=' -f2-)
  if [ ${#JWT_SECRET} -lt 32 ]; then
    err "HARNESS_JWT_SECRET 长度 < 32 字符（当前 ${#JWT_SECRET}），请在 .env 里改强"
    exit 1
  fi
}

ensure_openharness_dir() {
  # 让容器里的 oh 能复用宿主机的 ~/.openharness（credentials / skills / settings）
  if [ ! -d "$HOME/.openharness" ]; then
    warn "$HOME/.openharness 不存在，创建空目录（首次部署可后续填入凭证）"
    mkdir -p "$HOME/.openharness"
  fi
}

build_and_up() {
  log "构建并启动容器…"
  $COMPOSE_CMD up -d --build
  log "等待后端 healthy…"
  for i in $(seq 1 30); do
    status=$(docker inspect --format='{{.State.Health.Status}}' harness-backend 2>/dev/null || echo "starting")
    if [ "$status" = "healthy" ]; then
      log "后端已 healthy"
      return 0
    fi
    sleep 2
  done
  warn "后端 60s 内未 healthy，请运行：docker compose logs backend"
  return 1
}

reset_admin_password() {
  local username="${1:-}"
  local password="${2:-}"
  if [ -z "$username" ] || [ -z "$password" ]; then
    read -r -p "用户名（默认 admin）: " username
    username="${username:-admin}"
    read -r -s -p "新密码（>=8 位）: " password
    echo
    if [ ${#password} -lt 8 ]; then
      err "密码至少 8 位"
      exit 1
    fi
  fi

  log "更新 $username 的密码…"
  docker compose exec -T backend python3 -c "
import asyncio
from database import get_user_by_username, update_user
import main as bm
async def main():
    user = await get_user_by_username('$username')
    if not user:
        print('❌ 用户不存在')
        return
    await update_user(user['id'], password_hash=bm._hash_password('$password'))
    print('✅ 密码已更新')
asyncio.run(main())
"
}

# ─── 命令分发 ──────────────────────────────────────────
cmd="${1:-help}"

case "$cmd" in
  init)
    require_docker
    ensure_env_file
    ensure_openharness_dir
    build_and_up
    echo
    log "部署完成！"
    echo "  前端：http://$(hostname -I | awk '{print $1}'):3000"
    echo "  后端 API 文档：http://$(hostname -I | awk '{print $1}'):8000/docs"
    echo "  默认账号见 .env 中的 HARNESS_ADMIN_USERNAME / HARNESS_ADMIN_PASSWORD"
    echo
    warn "生产环境务必：1) 改默认密码 2) 在前面套 Nginx + HTTPS 3) 防火墙只开放 80/443"
    ;;
  update)
    require_docker
    log "拉取最新代码…"
    git pull
    build_and_up
    log "更新完成"
    ;;
  restart)
    require_docker
    $COMPOSE_CMD restart
    log "已重启"
    ;;
  logs)
    shift
    $COMPOSE_CMD logs -f "${@:-backend}"
    ;;
  status)
    $COMPOSE_CMD ps
    ;;
  admin)
    shift
    reset_admin_password "${@:-}"
    ;;
  help|--help|-h|"")
    cat <<EOF
Harness Platform 部署脚本

用法:
  $0 init                       # 首次部署（生成 .env、密钥、构建、启动）
  $0 update                     # 拉取新代码并重建
  $0 restart                    # 重启所有服务
  $0 logs [service...]          # 查看日志（默认 backend）
  $0 status                     # 容器状态
  $0 admin [username] [pass]    # 重置管理员密码（交互式或命令行）

环境要求：Docker + Docker Compose v2
EOF
    ;;
  *)
    err "未知命令：$cmd"
    echo "运行 '$0 help' 查看用法"
    exit 1
    ;;
esac