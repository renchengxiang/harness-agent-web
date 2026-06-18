# backend/database.py
import aiosqlite
import json
from pathlib import Path

DB_PATH = Path(__file__).parent / "harness.db"

async def init_db():
    """初始化数据库表"""
    async with aiosqlite.connect(DB_PATH) as db:
        await db.execute("""
            CREATE TABLE IF NOT EXISTS tasks (
                id          TEXT PRIMARY KEY,
                user_id     TEXT NOT NULL,
                prompt      TEXT NOT NULL,
                status      TEXT NOT NULL DEFAULT 'pending',
                output_file TEXT,
                output_files TEXT,
                error       TEXT,
                events      TEXT NOT NULL DEFAULT '[]',
                created_at  DATETIME DEFAULT CURRENT_TIMESTAMP,
                updated_at  DATETIME DEFAULT CURRENT_TIMESTAMP
            )
        """)
        await db.execute("""
            CREATE INDEX IF NOT EXISTS idx_user_id 
            ON tasks(user_id, created_at DESC)
        """)
        await db.commit()

async def save_task(task_id: str, user_id: str, prompt: str):
    """创建新任务"""
    async with aiosqlite.connect(DB_PATH) as db:
        await db.execute(
            """INSERT INTO tasks (id, user_id, prompt, status, events)
               VALUES (?, ?, ?, 'pending', '[]')""",
            (task_id, user_id, prompt)
        )
        await db.commit()

async def update_task(task_id: str, **kwargs):
    """更新任务字段"""
    if not kwargs:
        return

    # events 列表序列化
    if "events" in kwargs:
        kwargs["events"] = json.dumps(kwargs["events"], ensure_ascii=False)
    # output_files 列表序列化
    if "output_files" in kwargs:
        kwargs["output_files"] = json.dumps(kwargs["output_files"], ensure_ascii=False)

    fields = ", ".join(f"{k} = ?" for k in kwargs)
    values = list(kwargs.values()) + [task_id]

    async with aiosqlite.connect(DB_PATH) as db:
        await db.execute(
            f"UPDATE tasks SET {fields}, updated_at = CURRENT_TIMESTAMP WHERE id = ?",
            values
        )
        await db.commit()

async def get_task(task_id: str) -> dict | None:
    """获取单个任务"""
    async with aiosqlite.connect(DB_PATH) as db:
        db.row_factory = aiosqlite.Row
        async with db.execute(
            "SELECT * FROM tasks WHERE id = ?", (task_id,)
        ) as cursor:
            row = await cursor.fetchone()
            if not row:
                return None
            return _row_to_dict(row)

async def get_user_tasks(user_id: str, limit: int = 30) -> list[dict]:
    """获取用户的任务历史（最新在前）"""
    async with aiosqlite.connect(DB_PATH) as db:
        db.row_factory = aiosqlite.Row
        async with db.execute(
            """SELECT id, user_id, prompt, status, output_file, output_files, error, created_at
               FROM tasks
               WHERE user_id = ?
               ORDER BY created_at DESC
               LIMIT ?""",
            (user_id, limit)
        ) as cursor:
            rows = await cursor.fetchall()
            return [_row_to_dict(row) for row in rows]

def _row_to_dict(row: aiosqlite.Row) -> dict:
    d = dict(row)
    if "events" in d and isinstance(d["events"], str):
        d["events"] = json.loads(d["events"])
    if "output_files" in d and isinstance(d["output_files"], str):
        d["output_files"] = json.loads(d["output_files"])
    return d