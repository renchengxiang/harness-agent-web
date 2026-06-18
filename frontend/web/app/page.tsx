// frontend/web/app/page.tsx
"use client"

import { useState, useCallback, useEffect, useRef } from "react"
import { Badge } from "@/components/ui/badge"
import { Bot, Download, FileText, FolderOpen, ExternalLink, Loader2, X } from "lucide-react"
import { Button } from "@/components/ui/button"
import { PromptForm, ChatMode }    from "@/components/PromptForm"
import { EventLog }     from "@/components/EventLog"
import { TaskHistory }  from "@/components/TaskHistory"
import { FileManager }  from "@/components/FileManager"
import {
  createTask, subscribeTask, replyTask, stopTask,
  getUserId, getDownloadUrl, getTaskEvents,
  AgentEvent, DoneEvent, TaskMeta,
} from "@/lib/api"

type TaskState =
  | { phase: "idle" }
  | { phase: "running"; taskId: string; events: AgentEvent[] }
  | { phase: "ready";   taskId: string; events: AgentEvent[]; outputFiles: string[] }
  | { phase: "done";    taskId: string; events: AgentEvent[]; result: DoneEvent }
  | { phase: "error";   taskId: string; events: AgentEvent[]; message: string }

export default function Home() {
  const [userId, setUserId]           = useState<string>("")
  const [task, setTask]               = useState<TaskState>({ phase: "idle" })
  const [refreshTrigger, setRefresh]  = useState(0)
  const [fileManagerOpen, setFileManagerOpen] = useState(false)
  const [previewLoading, setPreviewLoading]   = useState(false)
  const [previewRunning, setPreviewRunning]   = useState(false)
  const [previewUrl, setPreviewUrl]           = useState<string | null>(null)

  // 客户端获取 userId（避免 SSR 问题）
  useEffect(() => { setUserId(getUserId()) }, [])

  const subscribeCleanupRef = useRef<(() => void) | null>(null)
  const currentTaskId = task.phase !== "idle" ? task.taskId : undefined

  // 公共 WS 事件处理：把 onEvent/onDone/onError 三个回调统一成一份
  // 保证 handleSubmit / subscribeToTask 行为一致。
  const buildHandlers = useCallback((targetTaskId: string) => ({
    onEvent: (event: AgentEvent) => {
      setTask((prev) => {
        if (prev.phase !== "running" || prev.taskId !== targetTaskId) return prev
        if (event.type === "ready") {
          const readyEvent = event as { type: "ready"; output_files?: string[] }
          // 同步刷新左侧历史列表（后端 DB 此时 status=ready）
          setRefresh((n) => n + 1)
          return {
            phase: "ready" as const,
            taskId: prev.taskId,
            events: prev.events,
            outputFiles: readyEvent.output_files || [],
          }
        }
        if (event.type === "waiting") {
          return {
            phase: "done" as const,
            taskId: prev.taskId,
            events: prev.events,
            result: { type: "done" as const, status: "waiting_user" },
          }
        }
        return { ...prev, events: [...prev.events, event] }
      })
    },
    onDone: (result: DoneEvent) => {
      setTask((prev) => {
        if (prev.phase === "idle") return prev
        if (prev.taskId !== targetTaskId) return prev
        if (prev.phase === "done" || prev.phase === "ready") return prev
        if (prev.phase !== "running") return prev
        if (result.status === "ready") {
          return {
            phase: "ready" as const,
            taskId: prev.taskId,
            events: prev.events,
            outputFiles: result.output_files || [],
          }
        }
        return { phase: "done", taskId: prev.taskId, events: prev.events, result }
      })
      setRefresh((n) => n + 1)
    },
    onError: (err: { stderr?: string }) => {
      setTask((prev) => {
        if (prev.phase !== "running" || prev.taskId !== targetTaskId) return prev
        // 兜底：onError 直接收到的可能没有详细信息，从已积累的事件流里取最后一条 error
        let msg = err.stderr
        if (!msg) {
          const errEvent = [...prev.events].reverse().find((e) => e.type === "error") as
            | { type: "error"; message?: string; stderr?: string }
            | undefined
          msg = errEvent?.message || errEvent?.stderr
        }
        return { phase: "error", taskId: prev.taskId, events: prev.events, message: msg || "未知错误" }
      })
      setRefresh((n) => n + 1)
    },
  }), [])

  const subscribeToTask = useCallback((taskId: string, offset: number = 0) => {
    subscribeCleanupRef.current?.()
    subscribeCleanupRef.current = null
    const handlers = buildHandlers(taskId)
    const cleanup = subscribeTask(
      taskId,
      handlers.onEvent,
      handlers.onDone,
      handlers.onError,
      offset,
    )
    subscribeCleanupRef.current = cleanup
    return cleanup
  }, [buildHandlers])

  // 首次提交需求
  const handleInitialSubmit = useCallback(async (prompt: string) => {
    if (!userId) return
    const taskId = await createTask(prompt, userId)
    // 把用户的需求作为第一条消息显示
    const userMsg: AgentEvent = { type: "user_message", text: prompt }
    setTask({ phase: "running", taskId, events: [userMsg] })
    subscribeToTask(taskId, 0)
    setRefresh((n) => n + 1)
  }, [userId, subscribeToTask])

  // 在 ready/waiting/error 阶段补充意见
  const handleReply = useCallback(async (content: string) => {
    if (!userId || !currentTaskId) return
    try {
      // 乐观插入用户气泡
      setTask((prev) => {
        if (prev.phase !== "done" && prev.phase !== "ready" && prev.phase !== "error") return prev
        const userMsg: AgentEvent = { type: "user_message", text: content }
        return { phase: "running", taskId: prev.taskId, events: [...prev.events, userMsg] }
      })

      await replyTask(currentTaskId, userId, content)

      // 重新订阅 WS。后端在 waiting/ready 阶段不关闭旧 WS，残留信号会破坏 running 状态，
      // 必须用当前事件数（含刚插入的 user_message，但后端不感知它，offset 还是不含 user_message）
      // 重新订阅。后端 events 数 = 前端 events 数 - 用户消息数；这里简单用 0 让后端从头补发，
      // 由 subscribeToTask 内部基于 phase==="running" 的检查避免重复显示——实际上后端 offset 是它自己的事件计数，
      // 我们只能传一个确切的后端 offset。改为：把 user_message 不计入 offset。
      // 计算后端 offset（剔除前端伪事件 user_message）
      const offset = (() => {
        if (task.phase === "idle") return 0
        return task.events.filter((e) => e.type !== "user_message").length
      })()
      // 等下一帧让 phase=running 落地
      setTimeout(() => subscribeToTask(currentTaskId, offset), 0)
    } catch (e) {
      console.error(e)
    }
  }, [userId, currentTaskId, subscribeToTask, task])

  // 决定调用 initial 还是 reply
  const handleSubmit = useCallback((text: string) => {
    if (task.phase === "idle") {
      handleInitialSubmit(text)
    } else if (task.phase === "ready" || task.phase === "done" || task.phase === "error") {
      handleReply(text)
    }
    // running 阶段忽略（按钮已 disabled）
  }, [task.phase, handleInitialSubmit, handleReply])

  const handleStop = useCallback(async () => {
    if (!currentTaskId) return
    try {
      await stopTask(currentTaskId)
    } catch (e) {
      console.error("停止任务失败", e)
    }
  }, [currentTaskId])

  // 选中历史任务
  const handleSelectTask = useCallback(async (selectedTask: TaskMeta) => {
    subscribeCleanupRef.current?.()
    subscribeCleanupRef.current = null

    const taskId = selectedTask.task_id

    let historyEvents: AgentEvent[] = []
    let actualStatus = selectedTask.status
    let outputFiles: string[] = selectedTask.output_files || []
    try {
      const data = await getTaskEvents(taskId)
      historyEvents = data.events || []
      actualStatus = data.status as TaskMeta["status"]
      outputFiles = data.output_files || selectedTask.output_files || []
    } catch (e) {
      console.error("加载事件历史失败", e)
    }

    // 历史任务的首条 prompt 作为用户气泡补到最前
    const userMsg: AgentEvent = { type: "user_message", text: selectedTask.prompt }
    const events = [userMsg, ...historyEvents]

    if (actualStatus === "running") {
      setTask({ phase: "running", taskId, events })
      subscribeToTask(taskId, historyEvents.length)
    } else if (actualStatus === "ready") {
      setTask({ phase: "ready", taskId, events, outputFiles })
    } else if (actualStatus === "waiting_user") {
      setTask({
        phase: "done",
        taskId,
        events,
        result: { type: "done", status: "waiting_user" },
      })
    } else if (actualStatus === "done") {
      setTask({
        phase: "done",
        taskId,
        events,
        result: {
          type: "done",
          status: "done",
          output_file: selectedTask.output_file,
        },
      })
    } else if (actualStatus === "error") {
      // 从事件流中提取真实错误信息（最后一个 error 事件的 message/stderr）
      const errEvent = [...historyEvents].reverse().find((e) => e.type === "error") as
        | { type: "error"; message?: string; stderr?: string }
        | undefined
      const errMsg = errEvent?.message || errEvent?.stderr || "任务执行失败"
      setTask({
        phase: "error",
        taskId,
        events,
        message: errMsg,
      })
    } else {
      setTask({
        phase: "done",
        taskId,
        events,
        result: { type: "done", status: "done" },
      })
    }
  }, [subscribeToTask])

  // 卸载时清理订阅
  useEffect(() => () => { subscribeCleanupRef.current?.() }, [])

  const handleStartPreview = useCallback(async () => {
    if (!currentTaskId) return
    setPreviewLoading(true)
    try {
      const { startPreview, stopPreview, getPreviewStatus } = await import("@/lib/api")
      if (previewRunning) {
        // 已运行 → 关闭
        await stopPreview(currentTaskId)
        setPreviewRunning(false)
        setPreviewUrl(null)
      } else {
        // 未运行 → 启动
        const result = await startPreview(currentTaskId)
        if (result.ok && result.url) {
          setPreviewRunning(true)
          setPreviewUrl(result.url)
          window.open(result.url, "_blank", "noopener,noreferrer")
        } else {
          alert(`启动预览失败: ${result.error || "未知错误"}`)
        }
      }
    } catch (e) {
      console.error("预览操作失败", e)
      alert(previewRunning ? "关闭预览失败" : "启动预览失败")
    }
    setPreviewLoading(false)
  }, [currentTaskId, previewRunning])

  // 切换任务时探测当前任务是否已有预览进程在跑（决定按钮文案）
  useEffect(() => {
    let cancelled = false
    if (!currentTaskId) {
      setPreviewRunning(false)
      setPreviewUrl(null)
      return
    }
    ;(async () => {
      try {
        const { getPreviewStatus } = await import("@/lib/api")
        const s = await getPreviewStatus(currentTaskId)
        if (cancelled) return
        setPreviewRunning(!!s.running)
        setPreviewUrl(s.url || null)
      } catch {
        if (!cancelled) {
          setPreviewRunning(false)
          setPreviewUrl(null)
        }
      }
    })()
    return () => { cancelled = true }
  }, [currentTaskId])

  const handleNewChat = useCallback(() => {
    subscribeCleanupRef.current?.()
    subscribeCleanupRef.current = null
    setTask({ phase: "idle" })
  }, [])

  // 当前 chat 模式
  const chatMode: ChatMode =
    task.phase === "idle"    ? "initial" :
    task.phase === "running" ? "running" :
    task.phase === "ready"   ? "ready" :
    task.phase === "error"   ? "error" :
    task.result.status === "waiting_user" ? "waiting" :
    task.result.status === "ready"        ? "ready" : "ready"

  const isLoading = task.phase === "running"
  const events    = task.phase !== "idle" ? task.events : []

  // 任务底部成果展示
  const resultPanel = (() => {
    if (task.phase === "ready") {
      return <DownloadList taskId={task.taskId} files={task.outputFiles} onBrowse={() => setFileManagerOpen(true)} />
    }
    if (task.phase === "done" && task.result.status === "done" && task.result.output_file) {
      return <DownloadList taskId={task.taskId} files={[task.result.output_file]} onBrowse={() => setFileManagerOpen(true)} />
    }
    if (task.phase === "error") {
      return (
        <div className="rounded-lg border border-red-200 bg-red-50 dark:bg-red-950/20 px-3 py-2 text-sm text-red-700 dark:text-red-400">
          ⚠️ {task.message || "任务执行失败"}，可在下方输入修改意见后重试。
        </div>
      )
    }
    return null
  })()

  return (
    <>
    <div className="flex h-screen bg-background overflow-hidden">

      {/* ── 左侧历史面板 ── */}
      <aside className="w-64 shrink-0 border-r flex-col hidden md:flex">
        <div className="flex items-center gap-2 px-4 py-3 border-b">
          <Bot className="h-5 w-5 text-primary" />
          <span className="font-semibold text-sm">Harness Platform</span>
        </div>

        <div className="px-3 py-2 border-b">
          <Button variant="outline" size="sm" className="w-full" onClick={handleNewChat}>
            + 新对话
          </Button>
        </div>

        {userId && (
          <TaskHistory
            userId={userId}
            currentTaskId={currentTaskId}
            onSelectTask={handleSelectTask}
            refreshTrigger={refreshTrigger}
          />
        )}

        <div className="px-4 py-3 border-t">
          <p className="text-xs text-muted-foreground">用户 ID</p>
          <p className="text-xs font-mono text-muted-foreground truncate mt-0.5">
            {userId.slice(0, 8)}...
          </p>
        </div>
      </aside>

      {/* ── 右侧主聊天区 ── */}
      <main className="flex-1 flex flex-col min-w-0">
        {/* 顶部工具条：仅在已有任务时显示 */}
        {task.phase !== "idle" && (
          <header className="border-b px-4 md:px-6 py-2.5 flex items-center justify-between gap-3 shrink-0">
            <div className="flex items-center gap-2 min-w-0">
              <span className="text-sm font-medium truncate">执行日志</span>
              {isLoading && (
                <span className="inline-flex h-2 w-2 rounded-full bg-blue-500 animate-pulse" />
              )}
              <Badge variant="outline" className="text-[11px] font-mono">
                {currentTaskId?.slice(0, 8)}
              </Badge>
            </div>
            <div className="flex items-center gap-2 shrink-0">
              <Button variant="ghost" size="sm" onClick={() => setFileManagerOpen(true)}>
                <FolderOpen className="h-3.5 w-3.5 mr-1" />
                文件
              </Button>
              <Button
                variant={previewRunning ? "secondary" : "ghost"}
                size="sm"
                onClick={handleStartPreview}
                disabled={previewLoading}
                title={previewRunning ? "关闭预览服务" : "启动预览服务"}
              >
                {previewLoading
                  ? <Loader2 className="h-3.5 w-3.5 mr-1 animate-spin" />
                  : previewRunning
                  ? <X className="h-3.5 w-3.5 mr-1" />
                  : <ExternalLink className="h-3.5 w-3.5 mr-1" />}
                {previewRunning ? "关闭预览" : "预览"}
              </Button>
            </div>
          </header>
        )}

        {/* 消息流 */}
        <div className="flex-1 overflow-y-auto">
          <div className="max-w-3xl mx-auto px-4 md:px-6 py-6">
            {task.phase === "idle" ? (
              <WelcomeHero />
            ) : (
              <>
                <EventLog events={events} fluid />
                {resultPanel && <div className="mt-4">{resultPanel}</div>}
              </>
            )}
          </div>
        </div>

        {/* 底部输入区 */}
        <div className="border-t bg-background/80 backdrop-blur shrink-0">
          <div className="max-w-3xl mx-auto px-4 md:px-6 py-3">
            <PromptForm
              onSubmit={handleSubmit}
              onStop={isLoading ? handleStop : undefined}
              loading={isLoading}
              mode={chatMode}
            />
          </div>
        </div>
      </main>
    </div>

      {currentTaskId && (
        <FileManager
          taskId={currentTaskId}
          open={fileManagerOpen}
          onClose={() => setFileManagerOpen(false)}
        />
      )}
    </>
  )
}

function WelcomeHero() {
  return (
    <div className="flex flex-col items-center justify-center text-center py-16 gap-3">
      <div className="h-12 w-12 rounded-2xl bg-primary/10 flex items-center justify-center">
        <Bot className="h-6 w-6 text-primary" />
      </div>
      <h1 className="text-2xl font-semibold">生成 PPT</h1>
      <p className="text-sm text-muted-foreground max-w-md">
        描述你的需求，Agent 会自动规划内容、设计排版并生成文件。
        生成后可以在下方继续提出修改意见，Agent 会在同一对话中持续迭代。
      </p>
    </div>
  )
}

function DownloadList({
  taskId, files, onBrowse,
}: { taskId: string; files: string[]; onBrowse: () => void }) {
  if (!files || files.length === 0) return null

  return (
    <div className="rounded-lg border border-green-200 bg-green-50 dark:bg-green-950/20 dark:border-green-900/40 p-3 space-y-2">
      <div className="flex items-center justify-between">
        <p className="text-sm font-medium text-green-700 dark:text-green-400 flex items-center gap-2">
          <FileText className="h-4 w-4" />
          已生成 {files.length} 个文件
        </p>
        <Button variant="ghost" size="sm" onClick={onBrowse} className="h-7 text-xs">
          <FolderOpen className="h-3.5 w-3.5 mr-1" />
          浏览全部
        </Button>
      </div>
      <div className="space-y-1">
        {files.map((f, i) => {
          const name = f.split("/").pop() || f
          return (
            <div key={i} className="flex items-center justify-between text-sm gap-2">
              <span className="text-green-700/80 dark:text-green-400/80 font-mono truncate flex-1">{name}</span>
              <Button size="sm" variant="outline" asChild className="h-7 shrink-0">
                <a href={getDownloadUrl(taskId, name)} download>
                  <Download className="h-3 w-3 mr-1" />
                  下载
                </a>
              </Button>
            </div>
          )
        })}
      </div>
    </div>
  )
}
