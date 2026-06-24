# backend/main.py
import asyncio
import json
import os
import re
import shutil
import sys
import time
import uuid
from contextlib import asynccontextmanager
from pathlib import Path
from typing import AsyncGenerator

from fastapi import FastAPI, WebSocket, WebSocketDisconnect, UploadFile
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import FileResponse
from pydantic import BaseModel

from database import init_db, save_task, update_task, get_task, get_user_tasks

# ─── DB 路径同步 helper（部分路由用同步 sqlite3 直连，需与 database.DB_PATH 保持一致） ───
import database as _db_mod  # noqa: E402
_DB_PATH = _db_mod.DB_PATH

# ─── 用户工作目录根路径 ────────────────────────────────────
# 可通过 HARNESS_USERS_ROOT 环境变量覆盖（Docker / 部署时使用）
USERS_ROOT = Path(os.environ.get("HARNESS_USERS_ROOT", "/Users/pc/www/harness_users"))
USERS_ROOT.mkdir(parents=True, exist_ok=True)

def get_user_cwd(user_id: str) -> str:
    """每个用户独立工作目录"""
    user_dir = USERS_ROOT / user_id
    user_dir.mkdir(parents=True, exist_ok=True)
    return str(user_dir)

def get_task_cwd(user_id: str, task_id: str) -> str:
    """每个任务独立工作目录（避免 --continue 串台）"""
    task_dir = USERS_ROOT / user_id / task_id
    task_dir.mkdir(parents=True, exist_ok=True)
    return str(task_dir)

# ─── oh 路径 ───────────────────────────────────────────────
OH_PATH = shutil.which("oh")
if not OH_PATH:
    raise RuntimeError("❌ 找不到 oh 命令")
print(f"✅ oh 路径: {OH_PATH}")

# ─── 内存中的实时事件缓冲（仅运行中任务使用）─────────────────
# 运行完成后事件持久化到 SQLite，内存缓冲清除
running_tasks: dict[str, list] = {}
# 存储运行中任务的 subprocess 引用，用于停止任务
running_processes: dict[str, asyncio.subprocess.Process] = {}

# ─── 预览服务追踪（按 project_path 分桶，便于跨任务复用）────
# value = {"proc": _sp.Popen, "port": int, "pid": int,
#          "task_id": str, "started_at": float, "last_used_at": float}
preview_services: dict[str, dict] = {}
MAX_PREVIEWS = 3  # 同时活跃预览数上限；超过按 LRU 回收最久未用的

# ─── 文件路径提取 ──────────────────────────────────────────
PPTX_PATTERN = re.compile(r'(?:/|(?:[\w.\-]+/)+)[^\s\'"]+\.pptx')

def extract_pptx_paths(event: dict, cwd: str | Path | None = None) -> list[str]:
    """提取事件中所有真实存在的 PPTX 文件路径

    支持绝对路径(/...)与相对路径(projects/.../x.pptx);相对路径需传入 cwd 才能 exists 校验。
    返回的路径统一为绝对路径,方便后续下载/打包。
    """
    text = json.dumps(event, ensure_ascii=False)
    found: list[str] = []
    cwd_path = Path(cwd) if cwd else None
    for path in PPTX_PATTERN.findall(text):
        candidate = Path(path)
        if not candidate.is_absolute():
            if cwd_path is None:
                continue
            candidate = cwd_path / path
        if candidate.exists():
            abs_path = str(candidate.resolve())
            if abs_path not in found:
                found.append(abs_path)
    return found

# ─── 等待用户确认的判断 ──────────────────────────────────────
WAITING_PATTERNS = [
    r'请确认', r'确认后', r'是否确认', r'请告诉我',
    r'需要修改', r'八项确认', r'请回复', r'[?？]\s*$'
]

def is_waiting_for_user(text: str) -> bool:
    if not text:
        return False
    return any(re.search(p, text, re.MULTILINE) for p in WAITING_PATTERNS)

# ─── 核心：调用 oh ─────────────────────────────────────────
async def start_agent(prompt: str, cwd: str, is_continue: bool = False) -> asyncio.subprocess.Process:
    """启动 oh 进程并返回 process 引用，供后续停止使用。

    ⚠️ is_continue 在此实现里仅作为提示，不再透传 -c 给 oh：
    oh 的 stream-json 模式（-p + --output-format stream-json）整个生命周期
    不会写 latest.json（只有 /session tag 之类的交互命令才会写），
    所以 -c 永远找不到 session → 立刻报 "No previous session found"。
    续写逻辑改为把历史 context 注入到 prompt 里，让 agent 走自然接续。
    """
    cmd = [OH_PATH]
    cmd.extend([
        "-p", prompt,
        "--output-format", "stream-json",
        "--permission-mode", "full_auto",
    ])
    # 清理 shell 中可能污染 oh 的 Claude Code 代理环境变量。
    # 例如 ANTHROPIC_MODEL=glm-5.1 会被 oh 当成 model override 强制覆盖 settings.json
    # 里配置的 MiniMax-M3，导致请求被打到 minimax 但带着 glm-5.1 → 400 unknown model。
    env = {k: v for k, v in os.environ.items() if not k.startswith(("ANTHROPIC_", "OPENHARNESS_MODEL"))}
    process = await asyncio.create_subprocess_exec(
        *cmd,
        stdout=asyncio.subprocess.PIPE,
        stderr=asyncio.subprocess.PIPE,
        cwd=cwd,
        env=env,
    )
    return process

async def read_stream(process: asyncio.subprocess.Process) -> AsyncGenerator[dict, None]:
    """读取 oh 进程的输出流"""
    async for line in process.stdout:
        line = line.decode().strip()
        if line:
            try:
                yield json.loads(line)
            except json.JSONDecodeError:
                yield {"type": "text", "content": line}

    stderr_output = await process.stderr.read()
    await process.wait()

    if process.returncode != 0:
        yield {
            "type": "error",
            "exit_code": process.returncode,
            "stderr": stderr_output.decode(),
        }

# ─── 后台任务执行器 ────────────────────────────────────────
async def execute_task(task_id: str, user_id: str, prompt: str, is_continue: bool = False):
    cwd = get_task_cwd(user_id, task_id)
    # 如果 running_tasks 中已有数据（由 reply_task 预填充），则跳过初始化
    if task_id not in running_tasks:
        running_tasks[task_id] = []
    output_files: list[str] = []
    last_assistant_text = ""
    # 续写场景下，下面会把已有 events 灌进 running_tasks。最终状态判断只能看本轮新增
    # 的事件，否则一次 stop（留下 error 事件）会让后续每一次 reply 都被判成 error，
    # 哪怕新一轮跑得很完美（PPTX 已生成）。这里记录"续写起点"。
    history_offset = 0

    # 如果是续写，恢复之前的事件和已发现的文件
    if is_continue:
        db_task = await get_task(task_id)
        existing_events = db_task.get("events", []) if db_task else []
        existing_files = db_task.get("output_files") or []
        original_prompt = (db_task or {}).get("prompt", "")
        if existing_files:
            output_files = existing_files.copy()
        if existing_events:
            running_tasks[task_id] = existing_events.copy()
            history_offset = len(existing_events)

        # 取最近一段 assistant 文本作为上下文摘要（避免 prompt 过长）
        last_assistant = ""
        for ev in reversed(existing_events):
            if ev.get("type") == "assistant_complete":
                t = (ev.get("text") or "").strip()
                if t:
                    last_assistant = t
                    break

        files_hint = "\n".join(f"- {f}" for f in existing_files) if existing_files else "(无)"
        context_parts = [f"## 续接上下文"]
        if original_prompt:
            context_parts.append(f"- 原始需求:{original_prompt}")
        if existing_files:
            context_parts.append(f"- 已有产出文件:\n{files_hint}")
        if last_assistant:
            # 截断避免 prompt 爆炸
            snippet = last_assistant[:500] + ("…" if len(last_assistant) > 500 else "")
            context_parts.append(f"- 上次 Agent 收尾文本:{snippet}")
        context_parts.append("")  # 空行
        context_block = "\n".join(context_parts)

        prompt = (
            f"{context_block}\n"
            f"## 用户最新意见\n{prompt}\n\n"
            f"## 任务\n"
            f"基于上述上下文继续执行任务；优先复用/修改已有文件，"
            f"完成剩余工作直到生成最终 PPTX 文件。"
        )

    await update_task(task_id, status="running")

    process: asyncio.subprocess.Process | None = None
    try:
        process = await start_agent(prompt, cwd, is_continue)
        running_processes[task_id] = process  # 保存引用供停止使用
        # 增量持久化阈值：每 N 个事件刷一次 DB，防止 uvicorn --reload 重载时
        # execute_task 收尾的 update_task 没机会执行，导致整个 stream 丢失。
        FLUSH_EVERY = 5
        pending_flush = 0
        async for event in read_stream(process):
            running_tasks[task_id].append(event)

            # 记录最后一句话，用于判断是否在等待确认
            if event.get("type") == "assistant_complete":
                last_assistant_text = event.get("text", "")

            # 实时提取文件路径（去重追加）
            new_files = extract_pptx_paths(event, cwd=cwd)
            for f in new_files:
                if f not in output_files:
                    output_files.append(f)
                    print(f"✅ [{task_id[:8]}] 发现输出文件: {f}")

            # 增量落盘：每隔 N 个事件把 events 写回 DB，
            # 防止 reload / crash 丢掉所有 stream。
            pending_flush += 1
            if pending_flush >= FLUSH_EVERY:
                pending_flush = 0
                await update_task(
                    task_id,
                    events=running_tasks[task_id],
                    output_files=output_files,
                )

    except Exception as e:
        await update_task(
            task_id,
            status="error",
            error=str(e),
            events=running_tasks.pop(task_id, [])
        )
        running_processes.pop(task_id, None)
        return

    # 任务完成/退出，清理进程引用
    running_processes.pop(task_id, None)
    events = running_tasks.pop(task_id, [])
    # 续写时，状态判定只看本轮新增事件；output_files 已经在循环里增量合并到全集，
    # 仍然反映完整产出。
    new_events = events[history_offset:] if history_offset else events

    # 如果是被用户停止的（returncode != 0 且 -9/SIGKILL）
    if process and process.returncode and process.returncode < 0:
        await update_task(
            task_id,
            status="error",
            error="任务被用户停止",
            events=events,
        )
        return

    # 检查是否有错误事件（仅本轮）
    has_any_error = any(e.get("type") == "error" for e in new_events)
    has_unrecoverable_error = any(
        e.get("type") == "error" and not e.get("recoverable", True)
        for e in new_events
    )

    # 检查是否是 API 限流（recoverable=True 的 429 错误）
    is_rate_limit = any(
        e.get("type") == "error" and "429" in str(e.get("message", ""))
        for e in new_events
    )

    # 状态决断逻辑
    if has_unrecoverable_error:
        final_status = "error"
    elif output_files:
        # 有输出文件 → ready（可下载可继续）
        final_status = "ready"
    elif has_any_error and not is_rate_limit:
        final_status = "error"
    elif is_rate_limit:
        # 限流时也设为 error（允许重试）
        final_status = "error"
    elif is_waiting_for_user(last_assistant_text):
        final_status = "waiting_user"
    else:
        final_status = "ready"

    await update_task(
        task_id,
        status=final_status,
        output_files=output_files,
        events=events,
    )

# ─── 生命周期：启动时初始化数据库 ─────────────────────────
@asynccontextmanager
async def lifespan(app: FastAPI):
    await init_db()
    print("✅ 数据库初始化完成")
    _cleanup_orphan_locks()
    yield

app = FastAPI(title="Harness Platform", lifespan=lifespan)
app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_methods=["*"],
    allow_headers=["*"],
)

# ─── API 路由 ──────────────────────────────────────────────

class TaskRequest(BaseModel):
    prompt: str
    user_id: str

class ReplyRequest(BaseModel):
    content: str
    user_id: str

class FileWriteRequest(BaseModel):
    path: str   # 相对 task_cwd 的路径
    content: str

class FileUploadRequest(BaseModel):
    path: str   # 相对 task_cwd 的目录路径

# 1. 提交任务
@app.post("/api/tasks")
async def create_task(req: TaskRequest):
    task_id = str(uuid.uuid4())
    await save_task(task_id, req.user_id, req.prompt)
    asyncio.create_task(execute_task(task_id, req.user_id, req.prompt))
    return {"task_id": task_id}

# 1.5 回复任务（续写等待用户确认或已有成果的任务）
@app.post("/api/tasks/{task_id}/reply")
async def reply_task(task_id: str, req: ReplyRequest):
    task = await get_task(task_id)
    if not task:
        return {"error": "not found"}
    if task["status"] not in ("waiting_user", "ready", "error"):
        return {"error": f"cannot reply, current status: {task['status']}"}

    # 预先初始化 running_tasks 和数据库状态，避免 WebSocket 时序竞争
    existing_events = task.get("events", [])
    running_tasks[task_id] = existing_events.copy()
    await update_task(task_id, status="running")

    asyncio.create_task(execute_task(task_id, req.user_id, req.content, is_continue=True))
    return {"ok": True}

# 1.6 停止正在运行的任务
@app.post("/api/tasks/{task_id}/stop")
async def stop_task(task_id: str):
    """终止正在运行的任务"""
    process = running_processes.get(task_id)
    if not process:
        return {"error": "task not running"}
    try:
        process.terminate()  # SIGTERM
        try:
            await asyncio.wait_for(process.wait(), timeout=5)
        except asyncio.TimeoutError:
            process.kill()  # SIGKILL
            await process.wait()
        running_processes.pop(task_id, None)
        # 也清理 running_tasks 让 WS 检测到
        return {"ok": True}
    except Exception as e:
        return {"error": str(e)}

# 1.7 删除任务（数据库记录 + 工作目录）
@app.delete("/api/tasks/{task_id}")
async def delete_task_endpoint(task_id: str):
    """删除任务记录和工作目录"""
    import sqlite3
    db_path = _DB_PATH
    try:
        conn = sqlite3.connect(str(db_path))
        row = conn.execute("SELECT user_id FROM tasks WHERE id = ?", (task_id,)).fetchone()
        conn.execute("DELETE FROM tasks WHERE id = ?", (task_id,))
        conn.commit()
        conn.close()
        if row:
            # 删除工作目录
            task_dir = USERS_ROOT / row[0] / task_id
            if task_dir.exists():
                shutil.rmtree(task_dir, ignore_errors=True)
        return {"ok": True}
    except Exception as e:
        return {"error": str(e)}


# 1.8 SVG 浏览器预览（启动 svg_editor 服务）
import subprocess as _sp
import socket as _socket

# svg_editor server.py 的绝对路径。可通过 OPENHARNESS_SVG_SERVER 覆盖
# （Docker / 部署时通常不需要，Python 会用 $HOME 拼默认值）。
_SKILL_SERVER_FALLBACK = Path(
    os.environ.get(
        "OPENHARNESS_SVG_SERVER",
        str(Path.home() / ".openharness/skills/ppt-master/scripts/svg_editor/server.py"),
    )
)
SKILL_SERVER = _SKILL_SERVER_FALLBACK
PREVIEW_PORT_START = 5050


def _find_free_port(start: int, exclude: set[int] = None) -> int:
    """从 start 开始找一个本机空闲端口。

    排除 exclude 中的端口（已被其它项目预约）。最多向上扫 200 个。
    """
    exclude = exclude or set()
    for port in range(start, start + 200):
        if port in exclude:
            continue
        with _socket.socket(_socket.AF_INET, _socket.SOCK_STREAM) as s:
            s.setsockopt(_socket.SOL_SOCKET, _socket.SO_REUSEADDR, 1)
            try:
                s.bind(("127.0.0.1", port))
            except OSError:
                continue
            return port
    raise RuntimeError(f"no free port in [{start}, {start + 200})")

def _detect_project_for_preview(task_id: str) -> Path | None:
    """检测任务的 ppt-master 项目根目录（传给 server.py 的 project_dir）。

    server.py 期望接收的是项目根目录，即包含 svg_output/ 子目录的路径。
    返回的目录中必须有一个 svg_output/ 子目录（含 .svg 文件）。
    """
    task_dir = _get_task_dir(task_id)
    if not task_dir:
        return None

    # 优先：task_dir 下直接有 svg_output/（独立项目）
    if (task_dir / "svg_output").exists() and any((task_dir / "svg_output").glob("*.svg")):
        return task_dir

    # 子目录中有 svg_output/
    for child in task_dir.iterdir():
        if child.is_dir() and not child.name.startswith("."):
            svg_out = child / "svg_output"
            if svg_out.exists() and any(svg_out.glob("*.svg")):
                return child

    # 子目录中有 svg_final/（备用输出目录）
    for child in task_dir.iterdir():
        if child.is_dir() and not child.name.startswith("."):
            svg_final = child / "svg_final"
            if svg_final.exists() and any(svg_final.glob("*.svg")):
                return child

    # projects/<name>/ 风格
    projects_dir = task_dir / "projects"
    if projects_dir.exists():
        for sub in sorted(projects_dir.iterdir()):
            if sub.is_dir():
                svg_out = sub / "svg_output"
                if svg_out.exists() and any(svg_out.glob("*.svg")):
                    return sub
                svg_final = sub / "svg_final"
                if svg_final.exists() and any(svg_final.glob("*.svg")):
                    return sub

    return None

def _read_preview_lock(project_path: Path) -> dict | None:
    """读取项目的预览服务锁文件（server.py 在项目根目录下写 .live_preview.lock）"""
    lock = project_path / ".live_preview.lock"
    if not lock.exists():
        return None
    try:
        info = json.loads(lock.read_text())
        # 验证进程是否还活着
        try:
            os.kill(info.get("pid", 0), 0)
            return info
        except (OSError, ProcessLookupError):
            return None  # 进程已死
    except Exception:
        return None

def _write_preview_lock(project_path: Path, pid: int, port: int):
    lock = project_path / ".live_preview.lock"
    lock.write_text(json.dumps({"pid": pid, "port": port, "started_at": time.time()}))


def _kill_preview(project_key: str) -> bool:
    """强制终止一个预览服务并清理锁文件。

    project_key 通常是 str(project_path)；传 task_id 也行（向后兼容）。
    返回 True 表示有进程被关闭。
    """
    svc = preview_services.get(project_key)
    if svc:
        proc = svc.get("proc")
        lock_path = Path(svc.get("project_path", "")) / ".live_preview.lock" if svc.get("project_path") else None
        try:
            if proc and proc.poll() is None:
                proc.terminate()
                try:
                    proc.wait(timeout=3)
                except _sp.TimeoutExpired:
                    proc.kill()
                    proc.wait(timeout=2)
        except Exception:
            pass
        if lock_path and lock_path.exists():
            try:
                lock_path.unlink(missing_ok=True)
            except OSError:
                pass
        preview_services.pop(project_key, None)
        return True

    # 没在内存里：可能后端刚重启、进程还活着（孤儿），直接用锁文件 kill
    # 调用方需要把 project_path 传进来；这里接受任意 lock_path 也行
    return False


def _user_id_for_task(task_id: str) -> str:
    """从 DB 反查 task 所属的 user_id（用于启动预览时注入回调环境变量）"""
    import sqlite3
    try:
        conn = sqlite3.connect(str(_DB_PATH))
        row = conn.execute("SELECT user_id FROM tasks WHERE id = ?", (task_id,)).fetchone()
        conn.close()
        return row[0] if row else ""
    except Exception:
        return ""


def _kill_preview_by_path(project_path: Path) -> bool:
    """按 project_path 关闭预览（兼容锁文件里的孤儿进程）"""
    key = str(project_path)
    if key in preview_services:
        return _kill_preview(key)
    lock = project_path / ".live_preview.lock"
    if lock.exists():
        try:
            info = json.loads(lock.read_text())
            os.kill(info.get("pid", 0), 15)  # SIGTERM
            try:
                os.waitpid(info["pid"], os.WNOHANG)
            except (ChildProcessError, OSError):
                pass
            lock.unlink(missing_ok=True)
            return True
        except (OSError, ProcessLookupError, json.JSONDecodeError):
            try:
                lock.unlink(missing_ok=True)
            except OSError:
                pass
    return False


def _enforce_preview_limit():
    """活跃预览超过 MAX_PREVIEWS 时按 LRU 杀最久未用的（last_used_at 最小）。"""
    # 过滤出还活着的
    alive = {
        k: v for k, v in preview_services.items()
        if v.get("proc") and v["proc"].poll() is None
    }
    if len(alive) <= MAX_PREVIEWS:
        return
    # 按 last_used_at 升序排
    ordered = sorted(alive.items(), key=lambda kv: kv[1].get("last_used_at", 0))
    to_kill = len(alive) - MAX_PREVIEWS
    for k, _ in ordered[:to_kill]:
        print(f"♻️ [preview] LRU 回收 {k}")
        _kill_preview(k)


def _cleanup_orphan_locks():
    """后端启动时清理孤儿锁文件（指 PID 已死但锁还在的）。"""
    if not USERS_ROOT.exists():
        return
    cleaned = 0
    for lock in USERS_ROOT.rglob(".live_preview.lock"):
        try:
            info = json.loads(lock.read_text())
            os.kill(info.get("pid", 0), 0)  # 不抛异常 = 还活着，保留
        except (OSError, ProcessLookupError):
            lock.unlink(missing_ok=True)
            cleaned += 1
        except (json.JSONDecodeError, KeyError):
            lock.unlink(missing_ok=True)
            cleaned += 1
    if cleaned:
        print(f"♻️ [preview] 启动时清理 {cleaned} 个孤儿锁")


@app.post("/api/tasks/{task_id}/preview")
async def start_preview(task_id: str):
    """启动 ppt-master的SVG浏览器预览服务

    端口策略：
    - 同一项目已有预览 → 直接复用锁里的 URL
    - 不同项目同时启动 → 第一个占 5050，第二个自动挑下一个空闲端口
    - 锁里写过的端口也算"已占用"，避免分配到已绑定的端口

    回收策略：
    - 全局同时活跃预览数 ≤ MAX_PREVIEWS；超过则按 LRU 杀最久未用的
    """
    project_path = _detect_project_for_preview(task_id)
    if not project_path:
        return {"error": "no ppt project found. Run agent to generate SVG files first."}

    project_key = str(project_path)
    now = time.time()

    # 如果该项目已经在运行 → 直接复用并刷新 last_used_at
    existing = _read_preview_lock(project_path)
    if existing:
        if project_key in preview_services:
            preview_services[project_key]["last_used_at"] = now
        else:
            # 后端内存丢了但进程还活着（罕见），补登记
            preview_services[project_key] = {
                "proc": None,  # 没引用，无法 stop
                "port": existing["port"],
                "pid": existing["pid"],
                "project_path": project_path,
                "task_id": task_id,
                "started_at": existing.get("started_at", now),
                "last_used_at": now,
            }
        return {
            "ok": True,
            "url": f"http://localhost:{existing['port']}",
            "project": str(project_path.relative_to(_get_task_dir(task_id).parent)),
            "already_running": True,
        }

    if not SKILL_SERVER.exists():
        return {"error": f"svg_editor server.py not found: {SKILL_SERVER}"}

    # 实际分配：socket bind 探测本机空闲端口，从 5050 起逐个尝试。
    try:
        port = _find_free_port(PREVIEW_PORT_START)
    except RuntimeError as e:
        return {"error": str(e)}

    # 启动新进程前先按 LRU 上限回收旧预览
    _enforce_preview_limit()

    proc = _sp.Popen(
        [sys.executable, str(SKILL_SERVER), str(project_path), "--no-browser", "--port", str(port)],
        cwd=str(project_path),
        stdout=_sp.DEVNULL,
        stderr=_sp.DEVNULL,
        start_new_session=True,
        # 注入回调用环境变量：svg_editor 在 /api/save-all 成功后会自动 POST 给后端，
        # 触发 apply-annotations 走 agent 应用修改 → 重新生成 PPTX
        env={
            **os.environ,
            "HARNESS_CALLBACK_URL": f"http://127.0.0.1:8000/api/tasks/{task_id}/apply-annotations",
            "HARNESS_USER_ID": _user_id_for_task(task_id),
            # 容器部署时透传 SVG_EDITOR_HOST=0.0.0.0，让宿主机能通过端口映射访问
            # （compose 暴露 5050-5060）。本地直接跑时不设这个 env，server.py 会用 127.0.0.1。
            **({"SVG_EDITOR_HOST": os.environ["SVG_EDITOR_HOST"]} if "SVG_EDITOR_HOST" in os.environ else {}),
        },
    )

    # 等待进程启动并写锁文件（server.py 自己写 .live_preview.lock 在 project_path 下）
    for _ in range(50):
        await asyncio.sleep(0.1)
        info = _read_preview_lock(project_path)
        if info:
            preview_services[project_key] = {
                "proc": proc,
                "port": info["port"],
                "pid": info["pid"],
                "project_path": project_path,
                "task_id": task_id,
                "started_at": info.get("started_at", now),
                "last_used_at": now,
            }
            return {
                "ok": True,
                "url": f"http://localhost:{info['port']}",
                "project": str(project_path.relative_to(_get_task_dir(task_id).parent)),
                "already_running": False,
            }

    # 检查进程是否提前退出（端口冲突会在这里暴露）
    if proc.poll() is not None:
        return {"error": "preview service process exited immediately"}

    # 锁文件没出现但进程还在运行 — 手动写锁并返回
    _write_preview_lock(project_path, proc.pid, port)
    preview_services[project_key] = {
        "proc": proc,
        "port": port,
        "pid": proc.pid,
        "project_path": project_path,
        "task_id": task_id,
        "started_at": now,
        "last_used_at": now,
    }
    return {
        "ok": True,
        "url": f"http://localhost:{port}",
        "project": str(project_path.relative_to(_get_task_dir(task_id).parent)),
        "already_running": False,
    }


@app.post("/api/tasks/{task_id}/preview/stop")
async def stop_preview(task_id: str):
    """关闭当前任务关联的预览服务（LRU 不会主动杀它）。"""
    project_path = _detect_project_for_preview(task_id)
    if not project_path:
        return {"error": "no ppt project for this task"}

    project_key = str(project_path)
    # 优先用内存里的引用（最干净的关闭路径）
    if project_key in preview_services:
        _kill_preview(project_key)
        return {"ok": True, "stopped": True}

    # 否则尝试从锁文件杀孤儿进程
    if _kill_preview_by_path(project_path):
        return {"ok": True, "stopped": True, "orphan": True}

    return {"ok": True, "stopped": False, "msg": "no preview running"}


@app.get("/api/tasks/{task_id}/preview/status")
async def preview_status(task_id: str):
    """查询当前任务的预览是否在跑 + URL（前端用于切按钮文案）。"""
    project_path = _detect_project_for_preview(task_id)
    if not project_path:
        return {"running": False, "reason": "no ppt project"}

    project_key = str(project_path)
    # 内存记录优先；也回退到锁文件探测（孤儿进程的情况）
    svc = preview_services.get(project_key)
    if svc and svc.get("proc") and svc["proc"].poll() is None:
        return {
            "running": True,
            "url": f"http://localhost:{svc['port']}",
            "port": svc["port"],
        }
    info = _read_preview_lock(project_path)
    if info:
        return {
            "running": True,
            "url": f"http://localhost:{info['port']}",
            "port": info["port"],
        }
    return {"running": False}


# 1.9 应用 SVG 标注（重新生成 + 触发 agent 应用注解）
@app.post("/api/tasks/{task_id}/apply-annotations")
async def apply_annotations(task_id: str, req: ReplyRequest):
    """应用标注并触发 Agent 重新生成"""
    task = await get_task(task_id)
    if not task:
        return {"error": "task not found"}
    if task["status"] not in ("waiting_user", "ready"):
        return {"error": f"cannot apply, status: {task['status']}"}

    # 构造一条包含标注应用的回复
    annotation_message = f"## 用户已提交 SVG 预览标注\n\n{req.content}\n\n请应用这些标注并重新生成 PPTX。"

    existing_events = task.get("events", [])
    running_tasks[task_id] = existing_events.copy()
    await update_task(task_id, status="running")

    asyncio.create_task(execute_task(task_id, req.user_id, annotation_message, is_continue=True))
    return {"ok": True}


# 2. 获取用户历史任务列表
@app.get("/api/users/{user_id}/tasks")
async def list_user_tasks(user_id: str):
    tasks = await get_user_tasks(user_id)
    # 不返回 events 字段（太大），只返回元数据
    return [
        {
            "task_id": t["id"],
            "prompt": t["prompt"],
            "status": t["status"],
            "output_file": t.get("output_file"),
            "output_files": t.get("output_files"),
            "created_at": t["created_at"],
        }
        for t in tasks
    ]

# 3. 查询单个任务状态
@app.get("/api/tasks/{task_id}")
async def get_task_status(task_id: str):
    task = await get_task(task_id)
    if not task:
        return {"error": "task not found"}
    return {
        "task_id": task["id"],
        "status": task["status"],
        "output_file": task.get("output_file"),
        "output_files": task.get("output_files"),
        "error": task.get("error"),
    }

# 4. 下载文件（可指定文件名）
@app.get("/api/tasks/{task_id}/download")
async def download_file(task_id: str, filename: str | None = None):
    task = await get_task(task_id)
    if not task:
        return {"error": "task not found"}
    if task["status"] not in ("done", "ready"):
        return {"error": f"task not ready, status: {task['status']}"}

    output_files = task.get("output_files") or []
    if task.get("output_file") and task["output_file"] not in output_files:
        output_files.append(task["output_file"])

    if not output_files:
        return {"error": "no output files"}

    # 如果指定了文件名，找对应文件
    if filename:
        matches = [f for f in output_files if Path(f).name == filename or f == filename]
        if not matches:
            return {"error": f"file not found: {filename}"}
        file_path = Path(matches[0])
    else:
        # 默认返回最后一个
        file_path = Path(output_files[-1])

    if not file_path.exists():
        return {"error": f"file not found on disk: {file_path}"}

    return FileResponse(
        path=str(file_path),
        filename=file_path.name,
        media_type="application/vnd.openxmlformats-officedocument.presentationml.presentation"
    )

# 4.5 列出任务的所有下载文件
@app.get("/api/tasks/{task_id}/files")
async def list_task_files(task_id: str):
    task = await get_task(task_id)
    if not task:
        return {"error": "task not found"}

    output_files = task.get("output_files") or []
    if task.get("output_file") and task["output_file"] not in output_files:
        output_files.append(task["output_file"])

    files = []
    for f in output_files:
        p = Path(f)
        if p.exists():
            files.append({
                "path": f,
                "name": p.name,
                "size": p.stat().st_size,
            })
    return {"files": files}


# 4.6 获取任务事件历史
@app.get("/api/tasks/{task_id}/events")
async def get_task_events(task_id: str):
    """获取任务的所有历史事件"""
    task = await get_task(task_id)
    if not task:
        return {"error": "task not found"}
    return {
        "task_id": task_id,
        "status": task["status"],
        "events": task.get("events", []),
        "output_files": task.get("output_files", []),
    }

# 5. WebSocket 实时订阅
@app.websocket("/ws/tasks/{task_id}")
async def task_websocket(websocket: WebSocket, task_id: str, offset: int = 0):
    """offset: 客户端已拥有的事件数，从 offset 开始发送新事件（避免重复）"""
    await websocket.accept()

    task = await get_task(task_id)
    if not task:
        await websocket.send_json({"type": "error", "msg": "task not found"})
        await websocket.close()
        return

    last_index = offset
    try:
        while True:
            # 优先从内存缓冲读（任务运行中）
            # 任务结束后从数据库读
            if task_id in running_tasks:
                events = running_tasks[task_id]
                db_status = "running"
            else:
                db_task = await get_task(task_id)
                events = db_task.get("events", []) if db_task else []
                db_status = db_task["status"] if db_task else "error"

            # 只发送 last_index 之后的新事件
            for event in events[last_index:]:
                await websocket.send_json(event)
            last_index = max(last_index, len(events))

            if db_status == "waiting_user":
                # 不关闭连接，发送 waiting 信号后继续轮询
                await websocket.send_json({
                    "type": "waiting",
                    "status": "waiting_user",
                })
            elif db_status == "ready":
                db_task = await get_task(task_id)
                output_files = db_task.get("output_files") or []
                if db_task.get("output_file") and db_task["output_file"] not in output_files:
                    output_files.append(db_task["output_file"])
                await websocket.send_json({
                    "type": "ready",
                    "status": "ready",
                    "output_files": output_files,
                })
                # ready 不关闭连接，继续轮询等待回复
            elif db_status in ("done", "error"):
                db_task = await get_task(task_id)
                await websocket.send_json({
                    "type": "done",
                    "status": db_status,
                    "output_file": db_task.get("output_file") if db_task else None,
                    "output_files": db_task.get("output_files") if db_task else None,
                    "error": db_task.get("error") if db_task else None,
                })
                break

            await asyncio.sleep(0.1)

    except WebSocketDisconnect:
        pass
    except RuntimeError as e:
        # WebSocket 已关闭时再次 send 或 close 的运行时错误，忽略
        if "close message" in str(e) or "send once" in str(e):
            pass
        else:
            raise
    finally:
        try:
            await websocket.close()
        except (RuntimeError, Exception):
            pass


# ─── 6. 文件管理 API ────────────────────────────────────────

def _get_task_dir(task_id: str) -> Path | None:
    """获取任务的工作目录"""
    import sqlite3
    try:
        conn = sqlite3.connect(str(_DB_PATH))
        row = conn.execute("SELECT user_id FROM tasks WHERE id = ?", (task_id,)).fetchone()
        conn.close()
        if row:
            return USERS_ROOT / row[0] / task_id
    except Exception:
        pass
    return None

def _detect_project_root(task_dir: Path) -> Path:
    """
    自动检测项目根目录。
    优先级：
    1. 找到包含 project.json 的子目录
    2. 找到 .openharness 目录下的项目子目录
    3. 找到 projects/ 目录（OH 风格）
    4. 找到第一个子目录（ppt-corn/、coffee-ppt/ 等）
    5. 都没有就返回 task_dir 本身
    """
    if not task_dir or not task_dir.exists():
        return task_dir

    # 1. 找包含 project.json 的子目录（递归一层）
    for child in task_dir.iterdir():
        if child.is_dir() and (child / "project.json").exists():
            return child

    # 2. 找 projects/ 目录
    projects_dir = task_dir / "projects"
    if projects_dir.exists() and projects_dir.is_dir():
        # 取第一个子目录作为项目
        children = [c for c in projects_dir.iterdir() if c.is_dir()]
        if children:
            return children[0]
        return projects_dir

    # 3. 找 .openharness/autopilot/projects 之类的子目录
    for child in task_dir.iterdir():
        if child.is_dir() and not child.name.startswith("."):
            return child

    return task_dir

def _resolve_fs_path(task_id: str, path: str) -> tuple[Path | None, Path | None]:
    """解析 fs 路径，返回 (task_dir, target)"""
    task_dir = _get_task_dir(task_id)
    if not task_dir:
        return None, None
    project_root = _detect_project_root(task_dir)
    target = (project_root / path.lstrip("/")).resolve()
    if not str(target).startswith(str(project_root.resolve())):
        return task_dir, None
    return task_dir, target

@app.get("/api/tasks/{task_id}/fs/tree")
async def fs_tree(task_id: str, dir: str = ""):
    """列出任务项目目录的文件树"""
    task_dir, target = _resolve_fs_path(task_id, dir)
    if not task_dir:
        return {"error": "task directory not found"}
    if not target:
        return {"error": "path outside project directory"}
    if not target.exists():
        return {"error": "path not found"}

    project_root = _detect_project_root(task_dir)

    if target.is_file():
        return {
            "type": "file",
            "name": target.name,
            "path": str(target.relative_to(project_root)),
            "size": target.stat().st_size,
        }

    items = []
    for child in sorted(target.iterdir()):
        rel = str(child.relative_to(project_root))
        if child.name.startswith(".") or rel.startswith(".openharness") or rel.startswith("node_modules"):
            continue
        items.append({
            "name": child.name,
            "path": rel,
            "type": "directory" if child.is_dir() else "file",
            "size": child.stat().st_size if child.is_file() else 0,
        })

    return {"type": "directory", "path": dir or ".", "children": items, "root": str(project_root.relative_to(task_dir))}


@app.get("/api/tasks/{task_id}/fs/read")
async def fs_read(task_id: str, path: str):
    """读取文件内容"""
    task_dir, file_path = _resolve_fs_path(task_id, path)
    if not task_dir:
        return {"error": "task not found"}
    if not file_path:
        return {"error": "path outside project directory"}
    if not file_path.exists() or not file_path.is_file():
        return {"error": "file not found"}

    project_root = _detect_project_root(task_dir)
    try:
        content = file_path.read_text(encoding="utf-8")
        return {
            "path": str(file_path.relative_to(project_root)),
            "content": content,
            "size": file_path.stat().st_size,
        }
    except UnicodeDecodeError:
        return {
            "path": str(file_path.relative_to(project_root)),
            "content": None,
            "size": file_path.stat().st_size,
            "binary": True,
        }


@app.post("/api/tasks/{task_id}/fs/write")
async def fs_write(task_id: str, req: FileWriteRequest):
    """写入/编辑文件"""
    task_dir, file_path = _resolve_fs_path(task_id, req.path)
    if not task_dir:
        return {"error": "task not found"}
    if not file_path:
        return {"error": "path outside project directory"}

    file_path.parent.mkdir(parents=True, exist_ok=True)
    file_path.write_text(req.content, encoding="utf-8")
    return {"ok": True, "path": req.path, "size": file_path.stat().st_size}


@app.post("/api/tasks/{task_id}/fs/upload")
async def fs_upload(task_id: str, path: str = "", file: UploadFile = None):
    """上传文件到项目目录"""
    task_dir = _get_task_dir(task_id)
    if not task_dir:
        return {"error": "task not found"}
    project_root = _detect_project_root(task_dir)

    if path:
        upload_dir = (project_root / path.lstrip("/")).resolve()
        if not str(upload_dir).startswith(str(project_root.resolve())):
            return {"error": "path outside project directory"}
    else:
        upload_dir = project_root

    upload_dir.mkdir(parents=True, exist_ok=True)

    if not file:
        return {"error": "no file provided"}

    dest = upload_dir / file.filename
    content = await file.read()
    dest.write_bytes(content)
    return {"ok": True, "path": str(dest.relative_to(project_root)), "size": len(content)}
