#!/usr/bin/env bash
# 配置 Nginx 反向代理 + Let's Encrypt HTTPS
# 用法：
#   sudo ./scripts/setup-nginx.sh harness.your-domain.com your-email@example.com

set -euo pipefail

if [ $# -lt 2 ]; then
  echo "用法：sudo $0 <domain> <email>"
  echo "  例：sudo $0 harness.example.com admin@example.com"
  exit 1
fi

DOMAIN="$1"
EMAIL="$2"

if [ "$(id -u)" -ne 0 ]; then
  echo "❌ 必须用 root 或 sudo 运行（要写 /etc/nginx/）"
  exit 1
fi

if ! command -v nginx >/dev/null 2>&1; then
  echo "📦 安装 nginx…"
  apt-get update && apt-get install -y --no-install-recommends nginx
fi

if ! command -v certbot >/dev/null 2>&1; then
  echo "📦 安装 certbot…"
  apt-get install -y --no-install-recommends certbot python3-certbot-nginx
fi

NGINX_CONF="/etc/nginx/sites-available/openharness"
cat > "$NGINX_CONF" <<EOF
server {
    listen 80;
    server_name $DOMAIN;

    location / {
        proxy_pass http://127.0.0.1:3000;
        proxy_set_header Host              \$host;
        proxy_set_header X-Real-IP         \$remote_addr;
        proxy_set_header X-Forwarded-For   \$proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto \$scheme;
    }

    location /api/ {
        proxy_pass http://127.0.0.1:8000/api/;
        proxy_set_header Host              \$host;
        proxy_set_header X-Real-IP         \$remote_addr;
        proxy_set_header X-Forwarded-For   \$proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto \$scheme;
    }

    location /ws/ {
        proxy_pass http://127.0.0.1:8000/ws/;
        proxy_http_version 1.1;
        proxy_set_header Upgrade    \$http_upgrade;
        proxy_set_header Connection "upgrade";
        proxy_set_header Host       \$host;
        proxy_read_timeout  3600s;
        proxy_send_timeout  3600s;
    }

    location /docs { proxy_pass http://127.0.0.1:8000/docs; }
    location /openapi.json { proxy_pass http://127.0.0.1:8000/openapi.json; }

    # 预览服务端口（SVG 编辑器）— 默认不暴露公网
    # 如果要让外部访问，单独再加一个 server block，或允许特定 IP。
}
EOF

ln -sf "$NGINX_CONF" /etc/nginx/sites-enabled/openharness
rm -f /etc/nginx/sites-enabled/default

nginx -t
systemctl reload nginx

echo "🔒 申请 Let's Encrypt 证书…"
certbot --nginx -d "$DOMAIN" --non-interactive --agree-tos -m "$EMAIL"

echo "✅ 配置完成"
echo "  访问：https://$DOMAIN"
echo "  文档：https://$DOMAIN/docs"
echo
echo "⚠️ 还需要确保 docker compose 的前端 NEXT_PUBLIC_API_URL 指向 /api："
echo "  编辑 docker-compose.yml 把 frontend.build.args.NEXT_PUBLIC_API_URL 改成 /api"
echo "  然后：docker compose up -d --build"