# syntax=docker/dockerfile:1.6

# ─── Stage 1: 安装依赖 ────────────────────────────────────
FROM node:20-alpine AS deps
WORKDIR /app

# npm 走淘宝镜像加速（默认 registry 在国内经常 timeout）
RUN npm config set registry https://registry.npmmirror.com

# 单独 COPY package 文件，最大化依赖层缓存
COPY package.json package-lock.json* ./
# 用 install 而非 ci：package-lock.json 可能与 package.json 不一致（缺新加的包）
RUN npm install --no-audit --no-fund

# ─── Stage 2: 构建 ────────────────────────────────────────
FROM node:20-alpine AS builder
WORKDIR /app

ENV NEXT_TELEMETRY_DISABLED=1

COPY --from=deps /app/node_modules ./node_modules
COPY . .

# 构建期注入 API URL（docker-compose 会通过 build arg 传入）
ARG NEXT_PUBLIC_API_URL
ENV NEXT_PUBLIC_API_URL=${NEXT_PUBLIC_API_URL}

RUN npm run build

# ─── Stage 3: 运行时 ──────────────────────────────────────
FROM node:20-alpine AS runner
WORKDIR /app

ENV NODE_ENV=production \
    NEXT_TELEMETRY_DISABLED=1

# 非 root 用户运行
RUN addgroup --system --gid 1001 nodejs && \
    adduser --system --uid 1001 nextjs

COPY --from=builder /app/public ./public

# 利用 Next.js standalone 输出（如果开启了的话），否则用 .next 完整目录
COPY --from=builder --chown=nextjs:nodejs /app/.next ./.next
COPY --from=builder /app/node_modules ./node_modules
COPY --from=builder /app/package.json ./package.json

USER nextjs

EXPOSE 3000

ENV PORT=3000 \
    HOSTNAME="0.0.0.0"

CMD ["npm", "start"]
