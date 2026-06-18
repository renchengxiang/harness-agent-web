// frontend/web/lib/api.ts

const BASE_URL = process.env.NEXT_PUBLIC_API_URL || "http://localhost:8000"
const WS_URL = BASE_URL.replace("http", "ws")

// ─── 用户 ID 管理 ──────────────────────────────────────────
export function getUserId(): string {
  if (typeof window === "undefined") return "ssr-user"
  let id = localStorage.getItem("harness_user_id")
  if (!id) {
    id = crypto.randomUUID()
    localStorage.setItem("harness_user_id", id)
  }
  return id
}

// ─── 任务类型 ──────────────────────────────────────────────
export type TaskMeta = {
  task_id: string
  prompt: string
  status: "pending" | "running" | "ready" | "done" | "error" | "waiting_user"
  output_file?: string
  output_files?: string[]
  created_at: string
}

export type AgentEvent =
  | { type: "assistant_delta";    text: string }
  | { type: "assistant_complete"; text: string }
  | { type: "tool_started";   tool_name: string; tool_input?: Record<string, unknown> }
  | { type: "tool_completed"; tool_name: string; output?: string; is_error: boolean }
  | { type: "waiting"; status: "waiting_user" }
  | { type: "ready"; status: "ready"; output_files?: string[] }
  | { type: "user_message"; text: string }   // 前端伪事件，用户输入气泡
  | DoneEvent
  | ErrorEvent

export type DoneEvent = {
  type: "done"
  status: "done" | "error" | "waiting_user" | "ready"
  output_file?: string
  output_files?: string[]
  error?: string
  waiting_user?: boolean
}

export type ErrorEvent = {
  type: "error"
  stderr?: string
  exit_code?: number
}

export type FileInfo = {
  path: string
  name: string
  size: number
}

export type FileNode = {
  name: string
  path: string
  type: "file" | "directory"
  size?: number
  children?: FileNode[]
}

export type FileContent = {
  path: string
  content: string | null
  size: number
  binary?: boolean
}

// ─── API 函数 ──────────────────────────────────────────────

export async function createTask(prompt: string, userId: string): Promise<string> {
  const resp = await fetch(`${BASE_URL}/api/tasks`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ prompt, user_id: userId }),
  })
  const data = await resp.json()
  return data.task_id
}

export async function getUserTasks(userId: string): Promise<TaskMeta[]> {
  const resp = await fetch(`${BASE_URL}/api/users/${userId}/tasks`)
  return resp.json()
}

export async function replyTask(taskId: string, userId: string, content: string): Promise<void> {
  const resp = await fetch(`${BASE_URL}/api/tasks/${taskId}/reply`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ content, user_id: userId }),
  })
  if (!resp.ok) {
    const data = await resp.json().catch(() => ({}))
    throw new Error(data.error || "回复失败")
  }
}

export function subscribeTask(
  taskId: string,
  onEvent: (event: AgentEvent) => void,
  onDone: (result: DoneEvent) => void,
  onError: (err: ErrorEvent) => void,
  offset: number = 0,
): () => void {
  const url = offset > 0
    ? `${WS_URL}/ws/tasks/${taskId}?offset=${offset}`
    : `${WS_URL}/ws/tasks/${taskId}`
  const ws = new WebSocket(url)
  let closed = false
  ws.onmessage = (msg) => {
    if (closed) return
    const event: AgentEvent = JSON.parse(msg.data)
    if (event.type === "done")        onDone(event as DoneEvent)
    else if (event.type === "error")  onError(event as ErrorEvent)
    else                              onEvent(event)
  }
  ws.onerror = () => {
    if (closed) return
    onError({ type: "error", stderr: "WebSocket 连接失败" })
  }
  return () => {
    // 必须先标记 closed 再 close：close() 可能触发 onerror（关闭中的连接），
    // 不解绑的话旧的 onError 闭包会把 phase 切成 error，导致 UI 显示错误但任务实际仍在跑。
    closed = true
    ws.onmessage = null
    ws.onerror = null
    ws.onclose = null
    try { ws.close() } catch { /* ignore */ }
  }
}

export function getDownloadUrl(taskId: string, filename?: string): string {
  let url = `${BASE_URL}/api/tasks/${taskId}/download`
  if (filename) url += `?filename=${encodeURIComponent(filename)}`
  return url
}

export async function getTaskFiles(taskId: string): Promise<FileInfo[]> {
  const resp = await fetch(`${BASE_URL}/api/tasks/${taskId}/files`)
  const data = await resp.json()
  return data.files || []
}

export async function getTaskEvents(taskId: string): Promise<{
  task_id: string
  status: string
  events: AgentEvent[]
  output_files: string[]
}> {
  const resp = await fetch(`${BASE_URL}/api/tasks/${taskId}/events`)
  return resp.json()
}

export async function stopTask(taskId: string): Promise<{ok?: boolean; error?: string}> {
  const resp = await fetch(`${BASE_URL}/api/tasks/${taskId}/stop`, { method: "POST" })
  return resp.json()
}

export async function deleteTask(taskId: string): Promise<{ok?: boolean; error?: string}> {
  const resp = await fetch(`${BASE_URL}/api/tasks/${taskId}`, { method: "DELETE" })
  return resp.json()
}

export async function startPreview(taskId: string): Promise<{
  ok?: boolean
  url?: string
  project?: string
  already_running?: boolean
  error?: string
}> {
  const resp = await fetch(`${BASE_URL}/api/tasks/${taskId}/preview`, { method: "POST" })
  return resp.json()
}

export async function stopPreview(taskId: string): Promise<{
  ok?: boolean
  stopped?: boolean
  orphan?: boolean
  error?: string
}> {
  const resp = await fetch(`${BASE_URL}/api/tasks/${taskId}/preview/stop`, { method: "POST" })
  return resp.json()
}

export async function getPreviewStatus(taskId: string): Promise<{
  running: boolean
  url?: string
  port?: number
  reason?: string
}> {
  const resp = await fetch(`${BASE_URL}/api/tasks/${taskId}/preview/status`)
  return resp.json()
}

export async function applyAnnotations(
  taskId: string,
  userId: string,
  content: string,
): Promise<{ok?: boolean; error?: string}> {
  const resp = await fetch(`${BASE_URL}/api/tasks/${taskId}/apply-annotations`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ content, user_id: userId }),
  })
  return resp.json()
}

// ─── 文件管理 API ─────────────────────────────────────────

export async function getFsTree(taskId: string, dir: string = ""): Promise<{type: string; path: string; children?: FileNode[]; name?: string; size?: number}> {
  const resp = await fetch(`${BASE_URL}/api/tasks/${taskId}/fs/tree?dir=${encodeURIComponent(dir)}`)
  return resp.json()
}

export async function readFile(taskId: string, path: string): Promise<FileContent> {
  const resp = await fetch(`${BASE_URL}/api/tasks/${taskId}/fs/read?path=${encodeURIComponent(path)}`)
  return resp.json()
}

export async function writeFile(taskId: string, path: string, content: string): Promise<{ok: boolean; path?: string; size?: number; error?: string}> {
  const resp = await fetch(`${BASE_URL}/api/tasks/${taskId}/fs/write`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ path, content }),
  })
  return resp.json()
}

export async function uploadFile(taskId: string, file: File, dirPath: string = ""): Promise<{ok: boolean; path?: string; size?: number; error?: string}> {
  const formData = new FormData()
  formData.append("file", file)
  const url = `${BASE_URL}/api/tasks/${taskId}/fs/upload?path=${encodeURIComponent(dirPath)}`
  const resp = await fetch(url, { method: "POST", body: formData })
  return resp.json()
}

// 格式化时间
export function formatRelativeTime(dateStr: string): string {
  const diff = Date.now() - new Date(dateStr).getTime()
  const minutes = Math.floor(diff / 60000)
  if (minutes < 1)  return "刚刚"
  if (minutes < 60) return `${minutes} 分钟前`
  const hours = Math.floor(minutes / 60)
  if (hours < 24)   return `${hours} 小时前`
  return `${Math.floor(hours / 24)} 天前`
}