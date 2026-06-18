# Web 端 Harness Agent 平台

> 状态：未发布。Web 平台作为 OpenHarness 的新前端入口，与 CLI / TUI 并存。

## 目标

把 OpenHarness 从命令行/TUI 形态扩展为 **Web 端的 agent 平台**：用户在浏览器里提交任务，Web 端把任务委派给本地 `oh` 子进程执行，事件流实时回传渲染，产物（PPT/文件）可在线预览与下载。

适用场景：
- 长任务（PPT 生成、批量代码改造）希望可视化跟踪而不是盯终端
- 多用户共享一台 agent 主机，每个用户隔离自己的工作目录
- 任务在 `waiting_user` 阶段需要人工续答

## 目录布局

```
openharness/
├── backend/                  # FastAPI 后端
│   ├── main.py               #   API + WebSocket 入口
│   ├── database.py           #   SQLite 任务持久化
│   ├── e2e_test.py           #   端到端多轮测试
│   └── test_v1.py            #   单点冒烟测试
│
├── frontend/web/             # Next.js 15 + React 19 Web 前端
│   ├── app/                  #   App Router 页面
│   ├── components/           #   业务组件（PromptForm / EventLog / TaskHistory / FileManager …）
│   ├── lib/api.ts            #   后端调用 + WebSocket 订阅封装
│   └── package.json
│
└── src/openharness/          # 共享 Python 核心（CLI / TUI / Web 后端共用）
    ├── cli.py                #   oh 命令入口
    ├── ui/app.py             #   -p print mode（Web 平台依赖）
    └── …
```

## 架构

```
浏览器 (Next.js)
  │
  │  HTTP:  POST /api/tasks, POST /api/tasks/{id}/reply, GET /api/tasks/{id}/files …
  │  WS:    /ws/tasks/{id}?offset=N    ←  agent 事件流
  ▼
FastAPI (backend/main.py)
  │
  │  asyncio.create_subprocess_exec(["oh", "-p", prompt, "--output-format", "stream-json", ...])
  │  写 stdout 解析为 AgentEvent → 推 WS + 写 SQLite
  ▼
oh 子进程 (src/openharness/cli.py)
  │
  │  走 print mode，跑 engine → stream_events → stdout
  ▼
OpenHarness Engine + Tools
```

关键点：
- **每个用户独立工作目录**：`USERS_ROOT/<user_id>/<task_id>/`，避免任务间 `--continue` 串台。
- **事件缓冲分层**：运行中任务用 `running_tasks`（内存）+ `running_processes`（停止句柄）；运行结束事件落 SQLite。
- **会话续写**：用户回复时，从 SQLite 读取历史 `messages` / `tool_metadata` 注入到 `oh -p` 的 prompt，让 agent 走自然接续（oh 的 stream-json 模式不写 `latest.json`，所以 `-c` 续写走不通）。
- **waiting_user 检测**：扫描事件文本是否包含 `请确认 / 请告诉我 / 需要修改 / ?` 等关键字，把 `done.status` 标为 `waiting_user` 让前端停止按钮变回"提交"。

## 启动

### 后端

```bash
# 依赖：pip install -e ".[dev]" 已包含 fastapi/aiosqlite/uvicorn
# 实际安装需要：pip install fastapi uvicorn aiosqlite
uvicorn backend.main:app --reload --port 8000
```

后端会：
1. 自动建表（`database.init_db`）
2. 创建 `USERS_ROOT`（默认 `/Users/pc/www/harness_users`，可用 `HARNESS_USERS_ROOT` 覆盖）
3. 创建 SQLite 数据库（默认 `backend/harness.db`，可用 `HARNESS_DB_PATH` 覆盖）
4. 解析 `oh` 路径（必须可执行，Docker 镜像里 `pip install -e ".[web]"` 会带进来）

### 前端

```bash
cd frontend/web
npm install
npm run dev    # http://localhost:3000
```

前端通过 `NEXT_PUBLIC_API_URL`（默认 `http://localhost:8000`）连后端。

### Docker 启动（推荐）

前置：装好 Docker Desktop / OrbStack。

```bash
# 构建并后台启动（首次会构建两个镜像，约 3-5 分钟）
docker compose up -d --build

# 查看状态
docker compose ps
docker compose logs -f backend    # 后端日志
docker compose logs -f frontend   # 前端日志

# 浏览器访问
open http://localhost:3000

# 停止
docker compose down               # 保留 volumes（数据不丢）
docker compose down -v            # 同时清掉 volumes（数据全删）
```

镜像架构：
- `backend` — `python:3.11-slim` 多阶段构建，先装 `openharness` 包（带入 `oh` CLI）和 `[web]` 额外依赖组（fastapi / uvicorn / aiosqlite），再裁剪到 runtime 层
- `frontend` — `node:20-alpine` 三阶段构建（deps / builder / runner），非 root 用户跑 `next start`
- 命名 volume：`harness_users`（工作目录）、`harness_db`（SQLite）
- 共享网络 `harness-net`（前端通过 `depends_on` 等后端 healthcheck 通过再启动）

环境变量：
- 后端 `HARNESS_USERS_ROOT` / `HARNESS_DB_PATH` — 持久化路径（Dockerfile 内置默认值 `/data/...`，已挂卷）
- 前端 `NEXT_PUBLIC_API_URL`（build arg）— 浏览器访问后端的地址。docker-compose 默认 `http://localhost:8000`（从浏览器视角）。**如果部署到服务器改成反代路径，改 `docker-compose.yml` 里 frontend.build.args.NEXT_PUBLIC_API_URL 后重新 build**
- API key：取消 `docker-compose.yml` 里 `ANTHROPIC_API_KEY` / `OPENAI_API_KEY` 的注释，并在 host 配好 `.env` 文件

挂载项目目录（让 agent 能改你机器上的代码）：
- 取消 `docker-compose.yml` 里 backend.volumes 的 `- /Users/pc/www:/projects:rw` 注释并改成你的项目根目录
- 创建任务时把 `cwd` 传 `/projects/<你的项目名>`

### 端到端冒烟

```bash
# 启动后端后再跑
python backend/test_v1.py "写一个关于咖啡的单页ppt"
python backend/e2e_test.py
```

## 主要 API

| 方法 | 路径 | 用途 |
|---|---|---|
| `POST` | `/api/tasks` | 创建任务（body: `prompt`, `user_id`, `cwd?`） |
| `POST` | `/api/tasks/{id}/reply` | waiting/ready 阶段续答 |
| `POST` | `/api/tasks/{id}/stop` | 停止运行中的任务 |
| `DELETE` | `/api/tasks/{id}` | 删除任务 |
| `GET` | `/api/tasks/{id}` | 任务元信息（status / output_files / events） |
| `GET` | `/api/tasks/{id}/events` | 历史事件（断线重连补发用） |
| `GET` | `/api/tasks/{id}/files` | 产物文件列表 |
| `GET` | `/api/tasks/{id}/download` | 文件下载（query: `filename`） |
| `GET` | `/api/tasks/{id}/fs/tree` | 任务目录树 |
| `GET` | `/api/tasks/{id}/fs/read` | 读文件 |
| `POST` | `/api/tasks/{id}/fs/write` | 写文件 |
| `POST` | `/api/tasks/{id}/preview` | 启动一个 dev server（写入 preview lock） |
| `POST` | `/api/tasks/{id}/apply-annotations` | 套用前端标注修改 |
| `GET` | `/api/users/{user_id}/tasks` | 列出某用户所有任务 |
| `WS` | `/ws/tasks/{id}?offset=N` | 实时事件流 |

## 事件协议

后端推给前端的 `AgentEvent` 形状（节选）：

```ts
type AgentEvent =
  | { type: "user_message"; text: string }            // 客户端伪事件，仅前端显示
  | { type: "system"; subtype: "init" | "compact"; … }
  | { type: "assistant"; message: { content: ContentBlock[] } }
  | { type: "assistant_delta"; text: string }          // 增量流式
  | { type: "tool_use"; name: string; input: any; id: string }
  | { type: "tool_result"; tool_use_id: string; content: string; is_error?: boolean }
  | { type: "result"; … }                              // 终止
  | { type: "ready"; output_files?: string[] }         // 后端补发：有产物可下载
  | { type: "waiting" }                                 // 后端补发：等用户回复
  | { type: "done"; status: "ready" | "waiting_user" | "completed" | "error"; … }
  | { type: "error"; message?: string; stderr?: string }
```

前端状态机：

```
idle ──(submit)──> running ──(ready event)──> ready
                  running ──(waiting event)─> done (status=waiting_user)
                  running ──(done event)────> done (status=completed)
                  running ──(error event)───> error
ready/done/error ──(submit)──> running (走 reply 流程)
```

## 与 CLI/TUI 的关系

- Web 平台**复用** `src/openharness` 的 engine / tools / channels，仅新增 `run_print_mode(... restore_messages=...)` 一个能力，让 `-p` 模式能接住恢复的会话消息。
- CLI / TUI 入口（`oh`）保持原样，文档不破坏。
- ohmo 子项目保留：它被 `channels/impl/{base,feishu}.py` 和 `services/cron_scheduler.py` 真实 import，不能整体删除。
- autopilot-dashboard / frontend/terminal 保留：本期不替换这两个旧前端，留作未来是否替换的决策。

## 已知局限

- 单机部署：后端假设 `oh` 在同一台机器可执行，没有做远端 agent 适配。
- `oh -p` 必须安装：后端启动时 `shutil.which("oh")` 找不到会直接抛 RuntimeError。
- `harness.db` 是 SQLite，并发写受限于单文件锁；多 worker 部署需要迁到 PostgreSQL。
- `USERS_ROOT` 路径硬编码在 `backend/main.py`，生产部署需要走环境变量。
