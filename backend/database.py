# backend/database.py
import os
import aiosqlite
import json
from pathlib import Path

# 可通过 HARNESS_DB_PATH 环境变量覆盖（Docker / 部署时挂卷用）
DB_PATH = Path(os.environ.get("HARNESS_DB_PATH", Path(__file__).parent / "harness.db"))
DB_PATH.parent.mkdir(parents=True, exist_ok=True)

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
        await _ensure_column(db, "tasks", "input_tokens", "INTEGER NOT NULL DEFAULT 0")
        await _ensure_column(db, "tasks", "output_tokens", "INTEGER NOT NULL DEFAULT 0")
        await _ensure_column(db, "tasks", "token_estimated", "INTEGER NOT NULL DEFAULT 0")
        await db.execute("""
            CREATE TABLE IF NOT EXISTS users (
                id            TEXT PRIMARY KEY,
                username      TEXT NOT NULL UNIQUE,
                password_hash TEXT NOT NULL,
                role          TEXT NOT NULL DEFAULT 'user',
                display_name  TEXT DEFAULT '',
                disabled      INTEGER NOT NULL DEFAULT 0,
                created_at    DATETIME DEFAULT CURRENT_TIMESTAMP,
                updated_at    DATETIME DEFAULT CURRENT_TIMESTAMP
            )
        """)
        await db.execute("""
            CREATE UNIQUE INDEX IF NOT EXISTS idx_users_username
            ON users(username)
        """)
        await db.execute("PRAGMA user_version = 1")
        await db.commit()

async def _ensure_column(db: aiosqlite.Connection, table: str, column: str, definition: str):
    cursor = await db.execute(f"PRAGMA table_info({table})")
    rows = await cursor.fetchall()
    columns = {row[1] for row in rows}
    if column not in columns:
        await db.execute(f"ALTER TABLE {table} ADD COLUMN {column} {definition}")

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
            """SELECT id, user_id, prompt, status, output_file, output_files, error,
                      input_tokens, output_tokens, token_estimated, created_at
               FROM tasks
               WHERE user_id = ?
               ORDER BY created_at DESC
               LIMIT ?""",
            (user_id, limit)
        ) as cursor:
            rows = await cursor.fetchall()
            return [_row_to_dict(row) for row in rows]

async def create_user(
    user_id: str,
    username: str,
    password_hash: str,
    role: str = "user",
    display_name: str = "",
) -> dict:
    """创建用户"""
    async with aiosqlite.connect(DB_PATH) as db:
        db.row_factory = aiosqlite.Row
        await db.execute(
            """INSERT INTO users (id, username, password_hash, role, display_name)
               VALUES (?, ?, ?, ?, ?)""",
            (user_id, username, password_hash, role, display_name),
        )
        await db.commit()
    user = await get_user_by_id(user_id)
    if not user:
        raise RuntimeError("user created but not found")
    return user

async def get_user_by_id(user_id: str) -> dict | None:
    """通过 ID 获取用户"""
    async with aiosqlite.connect(DB_PATH) as db:
        db.row_factory = aiosqlite.Row
        async with db.execute("SELECT * FROM users WHERE id = ?", (user_id,)) as cursor:
            row = await cursor.fetchone()
            return _row_to_dict(row) if row else None

async def get_user_by_username(username: str) -> dict | None:
    """通过用户名获取用户"""
    async with aiosqlite.connect(DB_PATH) as db:
        db.row_factory = aiosqlite.Row
        async with db.execute("SELECT * FROM users WHERE username = ?", (username,)) as cursor:
            row = await cursor.fetchone()
            return _row_to_dict(row) if row else None

async def list_users_with_usage() -> list[dict]:
    """列出用户及其任务/token 汇总"""
    async with aiosqlite.connect(DB_PATH) as db:
        db.row_factory = aiosqlite.Row
        async with db.execute(
            """
            SELECT
                u.id, u.username, u.role, u.display_name, u.disabled,
                u.created_at, u.updated_at,
                COUNT(t.id) AS task_count,
                COALESCE(SUM(t.input_tokens), 0) AS input_tokens,
                COALESCE(SUM(t.output_tokens), 0) AS output_tokens,
                COALESCE(SUM(CASE WHEN t.token_estimated > 0 THEN 1 ELSE 0 END), 0) AS estimated_count
            FROM users u
            LEFT JOIN tasks t ON t.user_id = u.id
            GROUP BY u.id
            ORDER BY u.created_at DESC
            """
        ) as cursor:
            rows = await cursor.fetchall()
            users = [_row_to_dict(row) for row in rows]
            for user in users:
                user["disabled"] = bool(user.get("disabled"))
                user["total_tokens"] = int(user.get("input_tokens") or 0) + int(user.get("output_tokens") or 0)
                user["has_estimated"] = bool(user.get("estimated_count"))
            return users

async def update_user(user_id: str, **kwargs) -> dict | None:
    """更新用户信息"""
    if not kwargs:
        return await get_user_by_id(user_id)
    fields = ", ".join(f"{k} = ?" for k in kwargs)
    values = list(kwargs.values()) + [user_id]
    async with aiosqlite.connect(DB_PATH) as db:
        await db.execute(
            f"UPDATE users SET {fields}, updated_at = CURRENT_TIMESTAMP WHERE id = ?",
            values,
        )
        await db.commit()
    return await get_user_by_id(user_id)

async def get_user_usage(user_id: str) -> dict:
    """获取用户 token 用量汇总"""
    async with aiosqlite.connect(DB_PATH) as db:
        db.row_factory = aiosqlite.Row
        async with db.execute(
            """
            SELECT
                COUNT(*) AS task_count,
                COALESCE(SUM(input_tokens), 0) AS input_tokens,
                COALESCE(SUM(output_tokens), 0) AS output_tokens,
                COALESCE(SUM(CASE WHEN token_estimated > 0 THEN 1 ELSE 0 END), 0) AS estimated_count
            FROM tasks
            WHERE user_id = ?
            """,
            (user_id,),
        ) as cursor:
            row = await cursor.fetchone()
            usage = _row_to_dict(row) if row else {
                "task_count": 0, "input_tokens": 0, "output_tokens": 0, "estimated_count": 0,
            }
            usage["total_tokens"] = int(usage.get("input_tokens") or 0) + int(usage.get("output_tokens") or 0)
            usage["has_estimated"] = bool(usage.get("estimated_count"))
            return usage

def public_user(user: dict) -> dict:
    """移除密码哈希，返回前端可见用户信息"""
    data = {k: v for k, v in user.items() if k != "password_hash"}
    if "disabled" in data:
        data["disabled"] = bool(data["disabled"])
    return data

def _row_to_dict(row: aiosqlite.Row) -> dict:
    d = dict(row)
    if "events" in d and isinstance(d["events"], str):
        d["events"] = json.loads(d["events"])
    if "output_files" in d and isinstance(d["output_files"], str):
        d["output_files"] = json.loads(d["output_files"])
    return d
