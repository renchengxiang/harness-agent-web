// frontend/web/components/TaskHistory.tsx
"use client"

import { useEffect, useState, useCallback } from "react"
import { ScrollArea } from "@/components/ui/scroll-area"
import { Button } from "@/components/ui/button"
import {
  CheckCircle2, XCircle, Loader2,
  Clock, Download, RefreshCw, Square, Trash2
} from "lucide-react"
import { TaskMeta, getUserTasks, getDownloadUrl, stopTask, deleteTask, formatRelativeTime } from "@/lib/api"
import { cn } from "@/lib/utils"

interface Props {
  userId: string
  currentTaskId?: string
  onSelectTask?: (task: TaskMeta) => void
  refreshTrigger?: number
}

export function TaskHistory({ userId, currentTaskId, onSelectTask, refreshTrigger }: Props) {
  const [tasks, setTasks]     = useState<TaskMeta[]>([])
  const [loading, setLoading] = useState(false)

  const fetchTasks = useCallback(async () => {
    setLoading(true)
    try {
      const data = await getUserTasks(userId)
      setTasks(data)
    } catch (e) {
      console.error("获取历史任务失败", e)
    } finally {
      setLoading(false)
    }
  }, [userId])

  useEffect(() => { fetchTasks() }, [fetchTasks, refreshTrigger])

  const handleStop = useCallback(async (taskId: string, e: React.MouseEvent) => {
    e.stopPropagation()
    if (!confirm("确定要停止这个任务吗？")) return
    try {
      const result = await stopTask(taskId)
      if (result.ok) {
        setTimeout(fetchTasks, 1000)
      } else {
        alert(`停止失败: ${result.error || "未知错误"}`)
      }
    } catch (e) {
      console.error("停止任务失败", e)
    }
  }, [fetchTasks])

  const handleDelete = useCallback(async (taskId: string, e: React.MouseEvent) => {
    e.stopPropagation()
    if (!confirm("确定要删除这个任务吗？这会删除任务记录和所有文件，不可恢复！")) return
    try {
      const result = await deleteTask(taskId)
      if (result.ok) {
        fetchTasks()
      } else {
        alert(`删除失败: ${result.error || "未知错误"}`)
      }
    } catch (e) {
      console.error("删除任务失败", e)
    }
  }, [fetchTasks])

  return (
    <div className="flex flex-col h-full">
      <div className="flex items-center justify-between px-4 py-3 border-b">
        <span className="text-sm font-medium">历史任务</span>
        <Button
          variant="ghost" size="icon"
          className="h-7 w-7"
          onClick={fetchTasks}
          disabled={loading}
        >
          <RefreshCw className={cn("h-3.5 w-3.5", loading && "animate-spin")} />
        </Button>
      </div>

      <ScrollArea className="flex-1">
        {tasks.length === 0 && !loading ? (
          <div className="flex flex-col items-center justify-center h-32 text-muted-foreground">
            <Clock className="h-6 w-6 mb-2 opacity-30" />
            <p className="text-xs">暂无历史任务</p>
          </div>
        ) : (
          <div className="p-2 space-y-1">
            {tasks.map((task) => (
              <TaskItem
                key={task.task_id}
                task={task}
                isActive={task.task_id === currentTaskId}
                onClick={() => onSelectTask?.(task)}
                onStop={(e) => handleStop(task.task_id, e)}
                onDelete={(e) => handleDelete(task.task_id, e)}
              />
            ))}
          </div>
        )}
      </ScrollArea>
    </div>
  )
}

function TaskItem({
  task,
  isActive,
  onClick,
  onStop,
  onDelete,
}: {
  task: TaskMeta
  isActive: boolean
  onClick: () => void
  onStop: (e: React.MouseEvent) => void
  onDelete: (e: React.MouseEvent) => void
}) {
  const showDownload = task.status === "ready" && task.output_files && task.output_files.length > 0
  const showStop = task.status === "running"

  return (
    <div
      onClick={onClick}
      className={cn(
        "group relative rounded-lg p-3 cursor-pointer transition-colors",
        "hover:bg-muted/60",
        isActive && "bg-muted ring-1 ring-primary/20"
      )}
    >
      <div className="flex items-start gap-2 pr-20">
        <StatusIcon status={task.status} />
        <div className="flex-1 min-w-0">
          <p className="text-sm leading-snug line-clamp-2 break-all">
            {task.prompt}
          </p>
          <p className="text-xs text-muted-foreground mt-1">
            {formatRelativeTime(task.created_at)}
          </p>
        </div>
      </div>

      {/* 操作按钮组 */}
      <div className="absolute right-2 top-2 flex items-center gap-0.5 opacity-0 group-hover:opacity-100 transition-opacity">
        {showDownload && (
          <a
            href={getDownloadUrl(task.task_id)}
            download
            onClick={(e) => e.stopPropagation()}
            className="p-1 rounded hover:bg-primary/10 text-primary"
            title="下载 PPT"
          >
            <Download className="h-3.5 w-3.5" />
          </a>
        )}
        {showStop && (
          <button
            onClick={onStop}
            className="p-1 rounded hover:bg-red-100 text-red-500"
            title="停止任务"
          >
            <Square className="h-3.5 w-3.5 fill-current" />
          </button>
        )}
        <button
          onClick={onDelete}
          className="p-1 rounded hover:bg-red-100 text-red-500"
          title="删除任务"
        >
          <Trash2 className="h-3.5 w-3.5" />
        </button>
      </div>
    </div>
  )
}

function StatusIcon({ status }: { status: TaskMeta["status"] }) {
  if (status === "done" || status === "ready")  return <CheckCircle2 className="h-4 w-4 text-green-500 mt-0.5 shrink-0" />
  if (status === "error")   return <XCircle      className="h-4 w-4 text-red-500   mt-0.5 shrink-0" />
  if (status === "running") return <Loader2      className="h-4 w-4 text-blue-500  mt-0.5 shrink-0 animate-spin" />
  return                           <Clock        className="h-4 w-4 text-gray-400  mt-0.5 shrink-0" />
}
