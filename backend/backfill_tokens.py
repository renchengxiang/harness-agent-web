#!/usr/bin/env python3
"""
从任务 events 中提取 token 用量，回填到 tasks.input_tokens/output_tokens。

策略：
- 如果 events 中存在 assistant_complete 事件的真实 input_tokens/output_tokens（>0）→ 用真实值。
- 否则基于 assistant_complete text 字符数 / 4 做估算，并把 token_estimated=1。

使用方式：
    python3 backend/backfill_tokens.py
"""
import asyncio
import json
import sys
from pathlib import Path

DB_PATH = Path(__file__).parent / "harness.db"

async def main() -> int:
    if not DB_PATH.exists():
        print(f"❌ 数据库不存在: {DB_PATH}")
        return 1

    import aiosqlite

    async with aiosqlite.connect(DB_PATH) as db:
        cursor = await db.execute("PRAGMA table_info(tasks)")
        cols = {row[1] for row in await cursor.fetchall()}
        if "input_tokens" not in cols or "output_tokens" not in cols:
            print("❌ tasks 表还没有 input_tokens/output_tokens 列")
            return 1

        # 确认 token_estimated 列
        has_estimated_col = "token_estimated" in cols

        cursor = await db.execute(
            "SELECT id, events FROM tasks WHERE input_tokens = 0 AND output_tokens = 0"
        )
        rows = await cursor.fetchall()
        print(f"🔍 检查 {len(rows)} 个 token 为 0 的任务")

        updated_real = 0
        updated_est = 0
        skipped = 0
        accum_chars = 0  # 用于估算 input 的"历史 assistant 字符"

        for task_id, events_json in rows:
            if not events_json:
                skipped += 1
                continue
            try:
                events = json.loads(events_json)
            except json.JSONDecodeError:
                skipped += 1
                continue

            total_input = 0
            total_output = 0
            has_real = False
            used_est = False
            accum_chars = 0

            for e in events:
                if not isinstance(e, dict):
                    continue
                if e.get("type") != "assistant_complete":
                    continue
                real_input = int(e.get("input_tokens") or 0)
                real_output = int(e.get("output_tokens") or 0)
                text = (e.get("text") or "").strip()
                chars = len(text)

                if real_input > 0 or real_output > 0:
                    total_input += real_input
                    total_output += real_output
                    has_real = True
                else:
                    total_output += max(1, chars // 4)
                    total_input += max(0, accum_chars // 4)
                    used_est = True
                accum_chars += chars

            if not has_real and not used_est:
                skipped += 1
                continue

            if has_estimated_col:
                await db.execute(
                    "UPDATE tasks SET input_tokens = ?, output_tokens = ?, token_estimated = ? WHERE id = ?",
                    (total_input, total_output, 1 if used_est else 0, task_id),
                )
            else:
                await db.execute(
                    "UPDATE tasks SET input_tokens = ?, output_tokens = ? WHERE id = ?",
                    (total_input, total_output, task_id),
                )
            if used_est and not has_real:
                updated_est += 1
                tag = "估算"
            else:
                updated_real += 1
                tag = "真实" if has_real else "混合"
            print(f"✅ [{task_id[:16]}] {tag} input={total_input}, output={total_output}")

        await db.commit()
        print(f"\n✅ 回填完成：{updated_real} 个真实/混合, {updated_est} 个纯估算, {skipped} 跳过")
    return 0

if __name__ == "__main__":
    sys.exit(asyncio.run(main()))
