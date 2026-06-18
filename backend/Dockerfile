# syntax=docker/dockerfile:1.6

# ─── Stage 1: 安装 openharness 包（包含 oh CLI） ──────────
FROM python:3.11-slim AS openharness-base

ENV PYTHONUNBUFFERED=1 \
    PYTHONDONTWRITEBYTECODE=1 \
    PIP_NO_CACHE_DIR=1 \
    PIP_DISABLE_PIP_VERSION_CHECK=1

# 一些 Python 包的 wheel 编译需要 gcc / libffi-dev
RUN apt-get update && apt-get install -y --no-install-recommends \
        gcc \
        libffi-dev \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /build

# 先只 COPY 依赖元数据，最大化 Docker 层缓存
COPY pyproject.toml ./
COPY src/ ./src/
COPY ohmo/ ./ohmo/
COPY frontend/ ./frontend/

# 安装包本体 + [web] 额外依赖组（fastapi/uvicorn/aiosqlite 等）
RUN pip install -e ".[web]"

# ─── Stage 2: 运行时镜像 ──────────────────────────────────
FROM python:3.11-slim AS runtime

ENV PYTHONUNBUFFERED=1 \
    PYTHONDONTWRITEBYTECODE=1

# 运行时只需要 aiosqlite / 客户端库需要的 ssl
RUN apt-get update && apt-get install -y --no-install-recommends \
        ca-certificates \
    && rm -rf /var/lib/apt/lists/*

# 从 builder 复制 site-packages
COPY --from=openharness-base /usr/local/lib/python3.11/site-packages /usr/local/lib/python3.11/site-packages
COPY --from=openharness-base /usr/local/bin /usr/local/bin

WORKDIR /app/backend

# 复制 backend 源码
COPY backend/ ./

# 默认数据目录（生产请挂卷覆盖）
ENV HARNESS_USERS_ROOT=/data/harness_users \
    HARNESS_DB_PATH=/data/harness.db

RUN mkdir -p /data

EXPOSE 8000

# 启动 FastAPI（4 worker 适合中等并发；调试可改 --reload）
CMD ["uvicorn", "main:app", "--host", "0.0.0.0", "--port", "8000", "--workers", "4"]
