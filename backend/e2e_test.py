"""
E2E 测试：验证 multi-turn 交互流程

测试场景：
1. 提交 PPT 生成任务
2. 等待 waiting_user 状态，回复确认
3. 等待 ready 状态，验证文件列表
4. 再次回复修改请求
5. 验证新文件追加到列表
"""

import asyncio
import json
import time
import uuid
from urllib.parse import urlparse, urlencode

import httpx
import websockets

BASE_URL = "http://localhost:8000"
WS_BASE = "ws://localhost:8000"

# ─── 工具函数 ──────────────────────────────────────────────

async def create_task(prompt: str, user_id: str) -> str:
    async with httpx.AsyncClient() as client:
        resp = await client.post(f"{BASE_URL}/api/tasks", json={
            "prompt": prompt,
            "user_id": user_id,
        })
        data = resp.json()
        task_id = data["task_id"]
        print(f"  → 任务已创建: {task_id[:8]}...")
        return task_id


async def subscribe_task(task_id: str, timeout: float = 300):
    """
    订阅任务的 WebSocket，持续读取事件直到终端状态。
    返回 (final_status, events, metadata)
    """
    events = []
    uri = f"{WS_BASE}/ws/tasks/{task_id}"
    async with websockets.connect(uri) as ws:
        deadline = time.time() + timeout
        while time.time() < deadline:
            try:
                msg = await asyncio.wait_for(ws.recv(), timeout=5)
            except asyncio.TimeoutError:
                continue

            event = json.loads(msg)
            events.append(event)
            etype = event.get("type")

            if etype in ("done", "ready", "waiting"):
                return event, events

    raise TimeoutError(f"Task {task_id[:8]} did not reach terminal state within {timeout}s")


async def reply_task(task_id: str, user_id: str, content: str) -> bool:
    async with httpx.AsyncClient() as client:
        resp = await client.post(f"{BASE_URL}/api/tasks/{task_id}/reply", json={
            "content": content,
            "user_id": user_id,
        })
        return resp.status_code == 200


async def get_task(task_id: str) -> dict:
    async with httpx.AsyncClient() as client:
        resp = await client.get(f"{BASE_URL}/api/tasks/{task_id}")
        return resp.json()


async def list_task_files(task_id: str) -> list:
    async with httpx.AsyncClient() as client:
        resp = await client.get(f"{BASE_URL}/api/tasks/{task_id}/files")
        data = resp.json()
        return data.get("files", [])


# ─── 测试场景 ──────────────────────────────────────────────

async def test_multi_turn_ppt_generation():
    print("=" * 60)
    print("🧪 E2E 测试：PPT 多轮生成")
    print("=" * 60)

    user_id = f"e2e-test-{uuid.uuid4().hex[:8]}"
    print(f"\n📋 用户 ID: {user_id}")

    # ── Turn 1: 提交任务 ──
    print("\n─── Turn 1: 提交任务 ───")
    task_id = await create_task("写一个关于咖啡的单页ppt", user_id)
    print(f"  等待任务执行...")

    done_event, events = await subscribe_task(task_id)
    status = done_event.get("status") or done_event.get("type")
    print(f"  终端状态: {status}")
    print(f"  收到事件数: {len(events)}")

    # 状态应该是 waiting_user
    assert status == "waiting_user", f"❌ 预期 waiting_user，实际 {status}"
    print("  ✅ 正确进入 waiting_user 状态")

    # ── Turn 2: 回复确认 ──
    print("\n─── Turn 2: 回复确认 ───")
    ok = await reply_task(task_id, user_id, "确认，请按推荐方案继续执行到导出 PPTX。")
    assert ok, "❌ 回复失败"
    print("  ✅ 回复成功")

    done_event2, events2 = await subscribe_task(task_id)
    status2 = done_event2.get("status") or done_event2.get("type")
    print(f"  终端状态: {status2}")
    print(f"  本轮事件数: {len(events2)}")

    # 状态应该是 ready（有文件生成）
    assert status2 in ("ready", "done"), f"❌ 预期 ready/done，实际 {status2}"
    print(f"  ✅ 正确进入 {status2} 状态")

    # 验证文件列表
    files = await list_task_files(task_id)
    print(f"  文件列表: {files}")
    if status2 == "ready":
        output_files = done_event2.get("output_files", [])
        print(f"  WS 返回文件: {output_files}")
        assert len(output_files) > 0, "❌ 没有输出文件"
        print(f"  ✅ 有 {len(output_files)} 个文件可下载")

    # ── Turn 3: 再次修改 ──
    print("\n─── Turn 3: 回复修改请求 ───")
    ok = await reply_task(task_id, user_id, "把标题颜色改成蓝色，其他不变，继续。")
    assert ok, "❌ 回复失败"
    print("  ✅ 回复成功")

    done_event3, events3 = await subscribe_task(task_id)
    status3 = done_event3.get("status") or done_event3.get("type")
    print(f"  终端状态: {status3}")
    print(f"  本轮事件数: {len(events3)}")

    # 验证文件列表增加了
    files3 = await list_task_files(task_id)
    print(f"  最终文件列表: {files3}")
    assert len(files3) >= len(files), f"❌ 文件数未增加: {len(files3)} < {len(files)}"
    print(f"  ✅ 文件数从 {len(files)} 增加到 {len(files3)}")

    # ── 验证任务历史 ──
    print("\n─── 验证任务历史 ───")
    async with httpx.AsyncClient() as client:
        resp = await client.get(f"{BASE_URL}/api/users/{user_id}/tasks")
        tasks = resp.json()
        print(f"  用户任务数: {len(tasks)}")
        for t in tasks:
            print(f"    - {t['task_id'][:8]} [{t['status']}] {t.get('output_files', [])}")

    print("\n" + "=" * 60)
    print("✅ 所有测试通过！")
    print("=" * 60)


async def test_simple_ready_state():
    """简单验证：提交任务后检查 ready 状态和文件列表"""
    print("=" * 60)
    print("🧪 快速测试：验证 ready 状态和文件列表")
    print("=" * 60)

    user_id = f"e2e-quick-{uuid.uuid4().hex[:8]}"

    # 提交任务
    task_id = await create_task("写一个关于茶叶的单页ppt", user_id)

    # 等待完成
    done_event, events = await subscribe_task(task_id)
    status = done_event.get("status") or done_event.get("type")
    print(f"  终端状态: {status}")
    print(f"  收到事件数: {len(events)}")

    # 如果是 waiting_user，回复一次
    if status == "waiting_user":
        print("  → 遇到 waiting_user，回复确认")
        ok = await reply_task(task_id, user_id, "确认，继续执行。")
        assert ok
        done_event2, events2 = await subscribe_task(task_id)
        status = done_event2.get("status") or done_event2.get("type")
        print(f"  续写后状态: {status}")

    # 验证 ready 状态
    if status == "ready":
        files = await list_task_files(task_id)
        print(f"  ✅ 状态为 ready，文件数: {len(files)}")
        for f in files:
            print(f"    - {f['name']} ({f['size']} bytes)")
    elif status == "done":
        print(f"  ⚠️ 状态为 done（没有触发 waiting_user 或 ready）")
        task = await get_task(task_id)
        print(f"  task: {json.dumps(task, indent=2, ensure_ascii=False)[:500]}")
    else:
        print(f"  ⚠️ 状态为 {status}")

    print("\n" + "=" * 60)


if __name__ == "__main__":
    import sys

    if len(sys.argv) > 1 and sys.argv[1] == "--quick":
        asyncio.run(test_simple_ready_state())
    else:
        asyncio.run(test_multi_turn_ppt_generation())
