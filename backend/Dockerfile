# syntax=docker/dockerfile:1.6

# ─── Stage 1: 安装 openharness 包（包含 oh CLI） ──────────
FROM python:3.11-slim AS openharness-base

ENV PYTHONUNBUFFERED=1 \
    PYTHONDONTWRITEBYTECODE=1 \
    PIP_NO_CACHE_DIR=1 \
    PIP_DISABLE_PIP_VERSION_CHECK=1 \
    PIP_INDEX_URL=https://pypi.tuna.tsinghua.edu.cn/simple/

# 一些 Python 包的 wheel 编译需要 gcc / libffi-dev
RUN apt-get update && apt-get install -y --no-install-recommends \
        gcc \
        libffi-dev \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /build

# 先只 COPY 依赖元数据，最大化 Docker 层缓存
COPY pyproject.toml README.md ./
COPY src/ ./src/
COPY ohmo/ ./ohmo/
COPY frontend/ ./frontend/

# 安装包本体 + [web] 额外依赖组（fastapi/uvicorn/aiosqlite 等）
# editable 模式：源码会留在 /build/src。runtime 镜像必须 COPY /build 过来，
# 否则 import openharness.cli 会报 "cannot import name 'cli'"。
RUN pip install -e ".[web]"

# 安装 skills 运行时依赖。当前只用到 ppt-master/svg_editor → flask；
# 后续新 skill 有额外依赖时也加在这里。
RUN pip install \
        "flask>=3.0.0" \
        "python-pptx>=1.0.2" \
        "Pillow>=10.0.0" \
        "lxml>=5.0.0"

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

# ⚠️ editable install 把源码留在 /build/src，必须也 COPY 过来。
# site-packages 里的 .pth 文件指向 /build，runtime 没这个路径 import 就失败。
COPY --from=openharness-base /build /build

WORKDIR /app/backend

# 复制 backend 源码
COPY backend/ ./

# 默认数据目录（生产请挂卷覆盖）
ENV HARNESS_USERS_ROOT=/data/harness_users \
    HARNESS_DB_PATH=/data/harness.db

RUN mkdir -p /data

EXPOSE 8000

# 启动 FastAPI
# ⚠️ 必须用单 worker：running_tasks / running_processes / preview_services 都是
# 进程内 dict，多 worker 下 WS 订阅会落到没有对应 agent 进程的 worker，
# 导致事件丢失 / stop 失败。要扩并发请改用 Redis/共享存储。
CMD ["uvicorn", "main:app", "--host", "0.0.0.0", "--port", "8000", "--workers", "1"]
