# test_v1.py
import asyncio
import json
import httpx
import websockets

BASE_URL = "http://localhost:8000"
WS_URL   = "ws://localhost:8000"

async def test(prompt: str):
    # 1. 提交任务
    async with httpx.AsyncClient() as client:
        resp = await client.post(f"{BASE_URL}/api/tasks", json={
            "prompt": prompt,
            "cwd": "/Users/pc/www"   # ← 你的工作目录
        })
        data = resp.json()
        task_id = data["task_id"]
        print(f"✅ 任务已提交，task_id: {task_id}\n")

    # 2. WebSocket 实时接收
    uri = f"{WS_URL}/ws/tasks/{task_id}"
    async with websockets.connect(uri, max_size=10*1024*1024) as ws:
        print("📡 开始接收事件流：\n")
        async for message in ws:
            event = json.loads(message)
            etype = event.get("type")

            if etype == "assistant_delta":
                print(event.get("text", ""), end="", flush=True)

            elif etype == "assistant_complete":
                print()

            elif etype == "tool_started":
                print(f"\n🔧 [{event.get('tool_name')}] 开始...")

            elif etype == "tool_completed":
                is_error = event.get("is_error", False)
                icon = "❌" if is_error else "✅"
                print(f"{icon} [{event.get('tool_name')}] 完成")

            elif etype == "done":
                output = event.get("output_file")
                print(f"\n{'='*50}")
                print(f"✅ 任务完成，status: {event['status']}")
                if output:
                    print(f"📄 输出文件: {output}")
                    print(f"⬇️  下载链接: {BASE_URL}/api/tasks/{task_id}/download")
                else:
                    print("⚠️  未检测到输出文件")
                break

            elif etype == "error":
                print(f"\n❌ 出错: {event}")
                break

asyncio.run(test("生成一个关于橘猫的单页PPT"))