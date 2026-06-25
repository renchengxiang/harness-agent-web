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

// ─── 认证存储与请求头 ─────────────────────────────────────
export function getAuthToken(): string | null {
  if (typeof window === "undefined") return null
  return localStorage.getItem("harness_token")
}

export function setAuthToken(token: string | null) {
  if (typeof window === "undefined") return
  if (token) localStorage.setItem("harness_token", token)
  else localStorage.removeItem("harness_token")
}

export function authHeaders(): Record<string, string> {
  const token = getAuthToken()
  return token ? { Authorization: `Bearer ${token}` } : {}
}

// ─── 任务类型 ──────────────────────────────────────────────
export type TaskMeta = {
  task_id: string
  user_id?: string
  prompt: string
  status: "pending" | "running" | "ready" | "done" | "error" | "waiting_user"
  output_file?: string
  output_files?: string[]
  input_tokens?: number
  output_tokens?: number
  total_tokens?: number
  token_estimated?: boolean
  created_at: string
  updated_at?: string
}

export type UserRole = "admin" | "user"

export type User = {
  id: string
  username: string
  role: UserRole
  display_name?: string
  disabled?: boolean
  created_at?: string
  updated_at?: string
}

export type UserWithUsage = User & {
  task_count?: number
  input_tokens?: number
  output_tokens?: number
  total_tokens?: number
}

export type UsageSummary = {
  task_count: number
  input_tokens: number
  output_tokens: number
  total_tokens: number
  has_estimated?: boolean
  user?: User
}

export type AdminTaskDetail = TaskMeta & {
  events?: AgentEvent[]
  error?: string | null
}

export type AgentEvent =
  | { type: "assistant_delta";    text: string }
  | { type: "assistant_complete"; text: string; input_tokens?: number; output_tokens?: number }
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
    headers: { "Content-Type": "application/json", ...authHeaders() },
    body: JSON.stringify({ prompt, user_id: userId }),
  })
  if (!resp.ok) {
    const data = await resp.json().catch(() => ({}))
    throw new Error(data.detail || data.error || "创建任务失败")
  }
  return resp.json().then((d) => d.task_id)
}

export async function getUserTasks(userId: string): Promise<TaskMeta[]> {
  const resp = await fetch(`${BASE_URL}/api/users/${userId}/tasks`, {
    headers: authHeaders(),
  })
  return resp.json()
}

export async function replyTask(taskId: string, userId: string, content: string): Promise<void> {
  const resp = await fetch(`${BASE_URL}/api/tasks/${taskId}/reply`, {
    method: "POST",
    headers: { "Content-Type": "application/json", ...authHeaders() },
    body: JSON.stringify({ content, user_id: userId }),
  })
  if (!resp.ok) {
    const data = await resp.json().catch(() => ({}))
    throw new Error(data.detail || data.error || "回复失败")
  }
}

export function subscribeTask(
  taskId: string,
  onEvent: (event: AgentEvent) => void,
  onDone: (result: DoneEvent) => void,
  onError: (err: ErrorEvent) => void,
  offset: number = 0,
): () => void {
  const params = new URLSearchParams()
  if (offset > 0) params.set("offset", String(offset))
  const token = getAuthToken()
  if (token) params.set("token", token)
  const query = params.toString()
  const url = `${WS_URL}/ws/tasks/${taskId}${query ? `?${query}` : ""}`
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
  // 浏览器原生 <a download> 不会带 Authorization 头，所以把 token 拼到 query 里。
  const params = new URLSearchParams()
  if (filename) params.set("filename", filename)
  const token = getAuthToken()
  if (token) params.set("token", token)
  const qs = params.toString()
  return qs
    ? `${BASE_URL}/api/tasks/${taskId}/download?${qs}`
    : `${BASE_URL}/api/tasks/${taskId}/download`
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
  input_tokens?: number
  output_tokens?: number
}> {
  const resp = await fetch(`${BASE_URL}/api/tasks/${taskId}/events`, {
    headers: authHeaders(),
  })
  return resp.json()
}

export async function stopTask(taskId: string): Promise<{ok?: boolean; error?: string}> {
  const resp = await fetch(`${BASE_URL}/api/tasks/${taskId}/stop`, {
    method: "POST",
    headers: authHeaders(),
  })
  return resp.json()
}

export async function deleteTask(taskId: string): Promise<{ok?: boolean; error?: string}> {
  const resp = await fetch(`${BASE_URL}/api/tasks/${taskId}`, {
    method: "DELETE",
    headers: authHeaders(),
  })
  return resp.json()
}

export async function startPreview(taskId: string): Promise<{
  ok?: boolean
  url?: string
  project?: string
  already_running?: boolean
  error?: string
}> {
  const resp = await fetch(`${BASE_URL}/api/tasks/${taskId}/preview`, {
    method: "POST",
    headers: authHeaders(),
  })
  return resp.json()
}

export async function stopPreview(taskId: string): Promise<{
  ok?: boolean
  stopped?: boolean
  orphan?: boolean
  error?: string
}> {
  const resp = await fetch(`${BASE_URL}/api/tasks/${taskId}/preview/stop`, {
    method: "POST",
    headers: authHeaders(),
  })
  return resp.json()
}

export async function getPreviewStatus(taskId: string): Promise<{
  running: boolean
  url?: string
  port?: number
  reason?: string
}> {
  const resp = await fetch(`${BASE_URL}/api/tasks/${taskId}/preview/status`, {
    headers: authHeaders(),
  })
  return resp.json()
}

export async function applyAnnotations(
  taskId: string,
  userId: string,
  content: string,
): Promise<{ok?: boolean; error?: string}> {
  const resp = await fetch(`${BASE_URL}/api/tasks/${taskId}/apply-annotations`, {
    method: "POST",
    headers: { "Content-Type": "application/json", ...authHeaders() },
    body: JSON.stringify({ content, user_id: userId }),
  })
  if (!resp.ok) {
    const data = await resp.json().catch(() => ({}))
    throw new Error(data.detail || data.error || "应用标注失败")
  }
  return resp.json()
}

// ─── 文件管理 API ─────────────────────────────────────────

export async function getFsTree(taskId: string, dir: string = ""): Promise<{type: string; path: string; children?: FileNode[]; name?: string; size?: number}> {
  const resp = await fetch(`${BASE_URL}/api/tasks/${taskId}/fs/tree?dir=${encodeURIComponent(dir)}`, {
    headers: authHeaders(),
  })
  return resp.json()
}

export async function readFile(taskId: string, path: string): Promise<FileContent> {
  const resp = await fetch(`${BASE_URL}/api/tasks/${taskId}/fs/read?path=${encodeURIComponent(path)}`, {
    headers: authHeaders(),
  })
  return resp.json()
}

export async function writeFile(taskId: string, path: string, content: string): Promise<{ok: boolean; path?: string; size?: number; error?: string}> {
  const resp = await fetch(`${BASE_URL}/api/tasks/${taskId}/fs/write`, {
    method: "POST",
    headers: { "Content-Type": "application/json", ...authHeaders() },
    body: JSON.stringify({ path, content }),
  })
  return resp.json()
}

export async function uploadFile(taskId: string, file: File, dirPath: string = ""): Promise<{ok: boolean; path?: string; size?: number; error?: string}> {
  const formData = new FormData()
  formData.append("file", file)
  const url = `${BASE_URL}/api/tasks/${taskId}/fs/upload?path=${encodeURIComponent(dirPath)}`
  const resp = await fetch(url, { method: "POST", headers: authHeaders(), body: formData })
  return resp.json()
}

// ─── 认证 API ──────────────────────────────────────────────
export async function login(username: string, password: string): Promise<{
  access_token: string
  token_type: string
  user: User
}> {
  const resp = await fetch(`${BASE_URL}/api/auth/login`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ username, password }),
  })
  if (!resp.ok) {
    const data = await resp.json().catch(() => ({}))
    throw new Error(data.detail || data.error || "登录失败")
  }
  return resp.json()
}

export async function fetchMe(): Promise<User> {
  const resp = await fetch(`${BASE_URL}/api/auth/me`, { headers: authHeaders() })
  if (!resp.ok) {
    throw new Error("未登录或登录已过期")
  }
  return resp.json()
}

// ─── 管理员 API ────────────────────────────────────────────
export async function adminListUsers(): Promise<UserWithUsage[]> {
  const resp = await fetch(`${BASE_URL}/api/admin/users`, { headers: authHeaders() })
  if (!resp.ok) {
    throw new Error("无法获取用户列表")
  }
  return resp.json()
}

export async function adminCreateUser(payload: {
  username: string
  password: string
  role: UserRole
  display_name?: string
}): Promise<User> {
  const resp = await fetch(`${BASE_URL}/api/admin/users`, {
    method: "POST",
    headers: { "Content-Type": "application/json", ...authHeaders() },
    body: JSON.stringify(payload),
  })
  if (!resp.ok) {
    const data = await resp.json().catch(() => ({}))
    throw new Error(data.detail || data.error || "创建失败")
  }
  return resp.json()
}

export async function adminUpdateUser(
  userId: string,
  payload: {
    password?: string
    role?: UserRole
    display_name?: string
    disabled?: boolean
  },
): Promise<User> {
  const resp = await fetch(`${BASE_URL}/api/admin/users/${userId}`, {
    method: "PATCH",
    headers: { "Content-Type": "application/json", ...authHeaders() },
    body: JSON.stringify(payload),
  })
  if (!resp.ok) {
    const data = await resp.json().catch(() => ({}))
    throw new Error(data.detail || data.error || "更新失败")
  }
  return resp.json()
}

export async function adminDisableUser(userId: string): Promise<User> {
  const resp = await fetch(`${BASE_URL}/api/admin/users/${userId}`, {
    method: "DELETE",
    headers: authHeaders(),
  })
  if (!resp.ok) {
    const data = await resp.json().catch(() => ({}))
    throw new Error(data.detail || data.error || "禁用失败")
  }
  return resp.json()
}

export async function adminListUserTasks(userId: string, limit = 100): Promise<TaskMeta[]> {
  const resp = await fetch(
    `${BASE_URL}/api/admin/users/${userId}/tasks?limit=${limit}`,
    { headers: authHeaders() },
  )
  if (!resp.ok) {
    throw new Error("无法获取用户任务")
  }
  return resp.json()
}

export async function adminGetUserUsage(userId: string): Promise<UsageSummary> {
  const resp = await fetch(`${BASE_URL}/api/admin/users/${userId}/usage`, {
    headers: authHeaders(),
  })
  if (!resp.ok) {
    throw new Error("无法获取用户用量")
  }
  return resp.json()
}

export async function adminGetTask(taskId: string): Promise<AdminTaskDetail> {
  const resp = await fetch(`${BASE_URL}/api/admin/tasks/${taskId}`, {
    headers: authHeaders(),
  })
  if (!resp.ok) {
    throw new Error("无法获取任务详情")
  }
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