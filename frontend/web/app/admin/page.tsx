"use client"

import Link from "next/link"
import { useEffect, useState } from "react"
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card"
import { adminListUsers, type UserWithUsage } from "@/lib/api"

export default function AdminOverviewPage() {
  const [users, setUsers] = useState<UserWithUsage[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    let cancelled = false
    adminListUsers()
      .then((data) => { if (!cancelled) setUsers(data) })
      .catch((e) => { if (!cancelled) setError(e.message) })
      .finally(() => { if (!cancelled) setLoading(false) })
    return () => { cancelled = true }
  }, [])

  const totalUsers = users.length
  const adminCount = users.filter((u) => u.role === "admin").length
  const totalTasks = users.reduce((acc, u) => acc + (u.task_count || 0), 0)
  const totalTokens = users.reduce((acc, u) => acc + (u.total_tokens || 0), 0)
  const totalInput = users.reduce((acc, u) => acc + (u.input_tokens || 0), 0)
  const totalOutput = users.reduce((acc, u) => acc + (u.output_tokens || 0), 0)

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-xl font-semibold">系统概览</h1>
        <p className="text-sm text-muted-foreground">实时汇总当前所有用户的活跃状态与 token 用量</p>
      </div>

      {error && (
        <Card className="border-destructive/40">
          <CardHeader>
            <CardTitle className="text-sm text-destructive">加载失败</CardTitle>
            <CardDescription>{error}</CardDescription>
          </CardHeader>
        </Card>
      )}

      <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-4 gap-4">
        <SummaryCard label="用户总数" value={loading ? "—" : String(totalUsers)} hint={`其中 ${adminCount} 名管理员`} />
        <SummaryCard label="任务总数" value={loading ? "—" : String(totalTasks)} hint="含所有用户会话" />
        <SummaryCard label="累计输入 token" value={loading ? "—" : totalInput.toLocaleString()} hint="prompt 总量" />
        <SummaryCard label="累计输出 token" value={loading ? "—" : totalOutput.toLocaleString()} hint={`合计 ${totalTokens.toLocaleString()}`} />
      </div>

      <Card>
        <CardHeader>
          <CardTitle className="text-sm">用户用量排行</CardTitle>
          <CardDescription>按累计 token 排序</CardDescription>
        </CardHeader>
        <CardContent>
          {loading ? (
            <p className="text-sm text-muted-foreground">加载中…</p>
          ) : users.length === 0 ? (
            <p className="text-sm text-muted-foreground">暂无用户</p>
          ) : (
            <div className="space-y-2">
              {[...users]
                .sort((a, b) => (b.total_tokens || 0) - (a.total_tokens || 0))
                .slice(0, 5)
                .map((user) => (
                  <Link
                    key={user.id}
                    href={`/admin/users/${user.id}`}
                    className="flex items-center justify-between rounded-md border px-3 py-2 text-sm hover:bg-muted transition-colors"
                  >
                    <div className="min-w-0">
                      <p className="font-medium truncate">{user.display_name || user.username}</p>
                      <p className="text-xs text-muted-foreground">{user.role} · {user.task_count || 0} 个会话</p>
                    </div>
                    <div className="text-right text-xs text-muted-foreground">
                      <p>输入 {(user.input_tokens || 0).toLocaleString()}</p>
                      <p>输出 {(user.output_tokens || 0).toLocaleString()}</p>
                    </div>
                  </Link>
                ))}
            </div>
          )}
        </CardContent>
      </Card>
    </div>
  )
}

function SummaryCard({ label, value, hint }: { label: string; value: string; hint?: string }) {
  return (
    <Card>
      <CardHeader className="pb-2">
        <CardDescription>{label}</CardDescription>
        <CardTitle className="text-2xl">{value}</CardTitle>
      </CardHeader>
      {hint && (
        <CardContent className="pt-0">
          <p className="text-xs text-muted-foreground">{hint}</p>
        </CardContent>
      )}
    </Card>
  )
}