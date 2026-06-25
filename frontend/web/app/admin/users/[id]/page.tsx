"use client"

import Link from "next/link"
import { useParams } from "next/navigation"
import { useCallback, useEffect, useState } from "react"
import { ArrowLeft, RefreshCw } from "lucide-react"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card"
import { ScrollArea } from "@/components/ui/scroll-area"
import { Separator } from "@/components/ui/separator"
import {
  adminGetUserUsage,
  adminListUserTasks,
  type TaskMeta,
  type UsageSummary,
  type User,
  formatRelativeTime,
} from "@/lib/api"

export default function AdminUserDetailPage() {
  const params = useParams<{ id: string }>()
  const userId = params?.id
  const [usage, setUsage] = useState<UsageSummary | null>(null)
  const [tasks, setTasks] = useState<TaskMeta[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)

  const load = useCallback(async () => {
    if (!userId) return
    setLoading(true)
    setError(null)
    try {
      const [u, t] = await Promise.all([
        adminGetUserUsage(userId),
        adminListUserTasks(userId, 100),
      ])
      setUsage(u)
      setTasks(t)
    } catch (e) {
      setError(e instanceof Error ? e.message : "加载失败")
    } finally {
      setLoading(false)
    }
  }, [userId])

  useEffect(() => { load() }, [load])

  if (!userId) return null

  const user = usage?.user

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between">
        <div>
          <Link
            href="/admin/users"
            className="text-xs text-muted-foreground hover:underline inline-flex items-center gap-1"
          >
            <ArrowLeft className="h-3 w-3" /> 返回用户列表
          </Link>
          <h1 className="text-xl font-semibold mt-1">
            {user?.display_name || user?.username || "用户详情"}
          </h1>
          {user && (
            <p className="text-sm text-muted-foreground">
              用户名 {user.username} · 角色 {user.role === "admin" ? "管理员" : "普通用户"}
            </p>
          )}
        </div>
        <Button variant="outline" size="sm" onClick={load} disabled={loading}>
          <RefreshCw className={`h-3.5 w-3.5 mr-1 ${loading ? "animate-spin" : ""}`} />
          刷新
        </Button>
      </div>

      {error && (
        <Card className="border-destructive/40">
          <CardContent className="py-3 text-sm text-destructive">{error}</CardContent>
        </Card>
      )}

      <div className="grid grid-cols-2 md:grid-cols-4 gap-4">
        <Stat label="任务总数" value={usage?.task_count ?? 0} />
        <Stat label="输入 tokens" value={(usage?.input_tokens ?? 0).toLocaleString()} />
        <Stat label="输出 tokens" value={(usage?.output_tokens ?? 0).toLocaleString()} />
        <Stat label="累计 tokens" value={(usage?.total_tokens ?? 0).toLocaleString()} />
      </div>

      {usage?.has_estimated && (
        <div className="rounded-md border border-amber-300/60 bg-amber-50 dark:bg-amber-950/20 px-3 py-2 text-xs text-amber-700 dark:text-amber-400">
          ⚠️ 部分任务的 token 是基于文本长度估算（LLM provider 未返回真实 usage）。
        </div>
      )}

      <Card>
        <CardHeader>
          <CardTitle className="text-sm">会话/任务记录</CardTitle>
          <CardDescription>查看该用户每一次会话的 prompt、状态、单次 token 用量</CardDescription>
        </CardHeader>
        <CardContent>
          {loading ? (
            <p className="text-sm text-muted-foreground">加载中…</p>
          ) : tasks.length === 0 ? (
            <p className="text-sm text-muted-foreground">暂无任务记录</p>
          ) : (
            <ScrollArea className="max-h-[480px] pr-2">
              <div className="divide-y">
                {tasks.map((task) => (
                  <div key={task.task_id} className="py-3 flex items-start gap-3">
                    <Badge variant={statusVariant(task.status)} className="shrink-0 mt-1">
                      {task.status}
                    </Badge>
                    <div className="flex-1 min-w-0">
                      <p className="text-sm leading-snug line-clamp-2 break-all">{task.prompt}</p>
                      <p className="text-xs text-muted-foreground mt-1">
                        {task.task_id.slice(0, 8)}… · {formatRelativeTime(task.created_at)}
                      </p>
                    </div>
                    <div className="text-right text-xs text-muted-foreground shrink-0">
                      <p>输入 {(task.input_tokens || 0).toLocaleString()}</p>
                      <p>输出 {(task.output_tokens || 0).toLocaleString()}</p>
                      <p className="font-medium">合计 {(task.total_tokens || 0).toLocaleString()}</p>
                      {task.token_estimated && (
                        <p className="text-amber-600 dark:text-amber-400 text-[10px]">估算</p>
                      )}
                    </div>
                  </div>
                ))}
              </div>
            </ScrollArea>
          )}
        </CardContent>
      </Card>

      <Separator />

      <Card>
        <CardHeader>
          <CardTitle className="text-sm">账号信息</CardTitle>
        </CardHeader>
        <CardContent className="space-y-2 text-sm">
          <KV k="用户 ID" v={userId} />
          <KV k="用户名" v={user?.username || "—"} />
          <KV k="显示名" v={user?.display_name || "—"} />
          <KV k="角色" v={user?.role || "—"} />
          <KV k="创建时间" v={user?.created_at?.slice(0, 19) || "—"} />
          <KV k="状态" v={user?.disabled ? "已禁用" : "正常"} />
        </CardContent>
      </Card>
    </div>
  )
}

function Stat({ label, value }: { label: string; value: string | number }) {
  return (
    <Card>
      <CardHeader className="pb-2">
        <CardDescription>{label}</CardDescription>
        <CardTitle className="text-2xl">{value}</CardTitle>
      </CardHeader>
    </Card>
  )
}

function KV({ k, v }: { k: string; v: string }) {
  return (
    <div className="flex">
      <span className="w-24 text-muted-foreground">{k}</span>
      <span className="flex-1 font-mono text-xs">{v}</span>
    </div>
  )
}

function statusVariant(status: TaskMeta["status"]): "default" | "secondary" | "destructive" | "outline" {
  switch (status) {
    case "ready":
    case "done":
      return "default"
    case "running":
    case "waiting_user":
      return "secondary"
    case "error":
      return "destructive"
    default:
      return "outline"
  }
}