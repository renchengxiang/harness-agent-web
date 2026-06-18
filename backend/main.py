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

# ─── 用户工作目录根路径 ────────────────────────────────────
USERS_ROOT = Path("/Users/pc/www/harness_users")
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

# ─── 文件路径提取 ──────────────────────────────────────────
PPTX_PATTERN = re.compile(r'/[^\s\'"]+\.pptx')

def extract_pptx_paths(event: dict) -> list[str]:
    """提取事件中所有真实存在的 PPTX 文件路径"""
    text = json.dumps(event, ensure_ascii=False)
    found = []
    for path in PPTX_PATTERN.findall(text):
        if Path(path).exists() and path not in found:
            found.append(path)
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
        async for event in read_stream(process):
            running_tasks[task_id].append(event)

            # 记录最后一句话，用于判断是否在等待确认
            if event.get("type") == "assistant_complete":
                last_assistant_text = event.get("text", "")

            # 实时提取文件路径（去重追加）
            new_files = extract_pptx_paths(event)
            for f in new_files:
                if f not in output_files:
                    output_files.append(f)
                    print(f"✅ [{task_id[:8]}] 发现输出文件: {f}")

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

    # 如果是被用户停止的（returncode != 0 且 -9/SIGKILL）
    if process and process.returncode and process.returncode < 0:
        await update_task(
            task_id,
            status="error",
            error="任务被用户停止",
            events=events,
        )
        return

    # 检查是否有错误事件
    has_any_error = any(e.get("type") == "error" for e in events)
    has_unrecoverable_error = any(
        e.get("type") == "error" and not e.get("recoverable", True)
        for e in events
    )

    # 检查是否是 API 限流（recoverable=True 的 429 错误）
    is_rate_limit = any(
        e.get("type") == "error" and "429" in str(e.get("message", ""))
        for e in events
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
    db_path = Path(__file__).parent / "harness.db"
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

SKILL_SERVER = Path("/Users/pc/.openharness/skills/ppt-master/scripts/svg_editor/server.py")

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

@app.post("/api/tasks/{task_id}/preview")
async def start_preview(task_id: str):
    """启动 ppt-master的SVG浏览器预览服务"""
    project_path = _detect_project_for_preview(task_id)
    if not project_path:
        return {"error": "no ppt project found. Run agent to generate SVG files first."}

    # 如果已经在运行，返回现有 URL
    existing = _read_preview_lock(project_path)
    if existing:
        return {
            "ok": True,
            "url": f"http://localhost:{existing['port']}",
            "project": str(project_path.relative_to(_get_task_dir(task_id).parent)),
            "already_running": True,
        }

    # 启动新的 server.py
    if not SKILL_SERVER.exists():
        return {"error": f"svg_editor server.py not found: {SKILL_SERVER}"}

    # server.py 接收的是项目根目录（包含 svg_output/），不是 svg_output/ 本身
    # 所以 project_path 就是项目根目录
    port = 5050
    proc = _sp.Popen(
        [sys.executable, str(SKILL_SERVER), str(project_path), "--no-browser", "--port", str(port)],
        cwd=str(project_path),
        stdout=_sp.DEVNULL,
        stderr=_sp.DEVNULL,
        start_new_session=True,
    )

    # 等待进程启动并写锁文件（server.py 自己写 .live_preview.lock 在 project_path 下）
    for _ in range(50):
        await asyncio.sleep(0.1)
        info = _read_preview_lock(project_path)
        if info:
            return {
                "ok": True,
                "url": f"http://localhost:{info['port']}",
                "project": str(project_path.relative_to(_get_task_dir(task_id).parent)),
                "already_running": False,
            }

    # 检查进程是否提前退出
    if proc.poll() is not None:
        return {"error": "preview service process exited immediately"}

    # 锁文件没出现但进程还在运行 — 手动写锁并返回
    _write_preview_lock(project_path, proc.pid, port)
    return {
        "ok": True,
        "url": f"http://localhost:{port}",
        "project": str(project_path.relative_to(_get_task_dir(task_id).parent)),
        "already_running": False,
    }


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
        conn = sqlite3.connect(str(Path(__file__).parent / "harness.db"))
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
