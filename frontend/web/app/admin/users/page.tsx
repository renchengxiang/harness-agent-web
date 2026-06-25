"use client"

import Link from "next/link"
import { useCallback, useEffect, useState, type FormEvent } from "react"
import { Plus, ShieldCheck, User as UserIcon, ShieldAlert } from "lucide-react"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card"
import {
  adminCreateUser,
  adminDisableUser,
  adminListUsers,
  type UserRole,
  type UserWithUsage,
} from "@/lib/api"

export default function AdminUsersPage() {
  const [users, setUsers] = useState<UserWithUsage[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [showForm, setShowForm] = useState(false)
  const [busy, setBusy] = useState(false)

  const load = useCallback(async () => {
    setLoading(true)
    setError(null)
    try {
      setUsers(await adminListUsers())
    } catch (e) {
      setError(e instanceof Error ? e.message : "加载失败")
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => { load() }, [load])

  const handleCreate = useCallback(async (payload: {
    username: string
    password: string
    role: UserRole
    display_name: string
  }) => {
    setBusy(true)
    setError(null)
    try {
      await adminCreateUser(payload)
      setShowForm(false)
      await load()
    } catch (e) {
      setError(e instanceof Error ? e.message : "创建失败")
    } finally {
      setBusy(false)
    }
  }, [load])

  const handleDisable = useCallback(async (id: string, name: string) => {
    if (!confirm(`确定要禁用用户「${name}」吗？`)) return
    setBusy(true)
    setError(null)
    try {
      await adminDisableUser(id)
      await load()
    } catch (e) {
      setError(e instanceof Error ? e.message : "禁用失败")
    } finally {
      setBusy(false)
    }
  }, [load])

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-xl font-semibold">用户管理</h1>
          <p className="text-sm text-muted-foreground">创建、查看、禁用用户账号</p>
        </div>
        <Button onClick={() => setShowForm((v) => !v)} disabled={busy}>
          <Plus className="h-4 w-4 mr-1.5" />
          新建用户
        </Button>
      </div>

      {error && (
        <Card className="border-destructive/40">
          <CardContent className="py-3 text-sm text-destructive">{error}</CardContent>
        </Card>
      )}

      {showForm && (
        <CreateUserForm
          busy={busy}
          onCancel={() => setShowForm(false)}
          onSubmit={handleCreate}
        />
      )}

      <Card>
        <CardHeader>
          <CardTitle className="text-sm">所有用户</CardTitle>
        </CardHeader>
        <CardContent>
          {loading ? (
            <p className="text-sm text-muted-foreground">加载中…</p>
          ) : users.length === 0 ? (
            <p className="text-sm text-muted-foreground">暂无用户</p>
          ) : (
            <div className="divide-y">
              {users.map((user) => (
                <div key={user.id} className="flex items-center justify-between py-3 gap-4">
                  <Link href={`/admin/users/${user.id}`} className="flex-1 min-w-0 hover:underline">
                    <p className="font-medium truncate">{user.display_name || user.username}</p>
                    <p className="text-xs text-muted-foreground truncate">
                      {user.username} · 创建于 {user.created_at?.slice(0, 10) || "未知"}
                    </p>
                  </Link>
                  <div className="flex items-center gap-2 shrink-0">
                    <Badge variant={user.role === "admin" ? "default" : "secondary"}>
                      {user.role === "admin"
                        ? <><ShieldCheck className="h-3 w-3 mr-1" />管理员</>
                        : <><UserIcon className="h-3 w-3 mr-1" />普通</>
                      }
                    </Badge>
                    {user.disabled && <Badge variant="destructive">已禁用</Badge>}
                    <span className="text-xs text-muted-foreground w-20 text-right">
                      {(user.task_count || 0)} 个会话
                    </span>
                    <span className="text-xs text-muted-foreground w-28 text-right">
                      {(user.total_tokens || 0).toLocaleString()} tokens
                    </span>
                    <Button
                      size="sm"
                      variant="ghost"
                      disabled={user.disabled || busy}
                      onClick={() => handleDisable(user.id, user.display_name || user.username)}
                    >
                      <ShieldAlert className="h-3.5 w-3.5 mr-1" />
                      禁用
                    </Button>
                  </div>
                </div>
              ))}
            </div>
          )}
        </CardContent>
      </Card>
    </div>
  )
}

function CreateUserForm({
  busy,
  onCancel,
  onSubmit,
}: {
  busy: boolean
  onCancel: () => void
  onSubmit: (payload: { username: string; password: string; role: UserRole; display_name: string }) => Promise<void>
}) {
  const [username, setUsername] = useState("")
  const [password, setPassword] = useState("")
  const [role, setRole] = useState<UserRole>("user")
  const [displayName, setDisplayName] = useState("")

  const handleSubmit = async (event: FormEvent) => {
    event.preventDefault()
    if (!username.trim() || !password) return
    await onSubmit({ username: username.trim(), password, role, display_name: displayName.trim() })
    setUsername("")
    setPassword("")
    setDisplayName("")
    setRole("user")
  }

  return (
    <Card>
      <CardHeader>
        <CardTitle className="text-sm">新建用户</CardTitle>
      </CardHeader>
      <CardContent>
        <form onSubmit={handleSubmit} className="grid grid-cols-1 md:grid-cols-2 gap-3">
          <Field label="用户名" required>
            <input
              className="w-full rounded-md border bg-background px-3 py-2 text-sm outline-none focus-visible:ring-2 focus-visible:ring-ring"
              value={username}
              onChange={(e) => setUsername(e.target.value)}
              required
            />
          </Field>
          <Field label="密码" required>
            <input
              type="password"
              className="w-full rounded-md border bg-background px-3 py-2 text-sm outline-none focus-visible:ring-2 focus-visible:ring-ring"
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              required
              minLength={6}
            />
          </Field>
          <Field label="显示名">
            <input
              className="w-full rounded-md border bg-background px-3 py-2 text-sm outline-none focus-visible:ring-2 focus-visible:ring-ring"
              value={displayName}
              onChange={(e) => setDisplayName(e.target.value)}
            />
          </Field>
          <Field label="角色">
            <select
              className="w-full rounded-md border bg-background px-3 py-2 text-sm outline-none focus-visible:ring-2 focus-visible:ring-ring"
              value={role}
              onChange={(e) => setRole(e.target.value as UserRole)}
            >
              <option value="user">普通用户</option>
              <option value="admin">管理员</option>
            </select>
          </Field>
          <div className="md:col-span-2 flex items-center justify-end gap-2">
            <Button type="button" variant="ghost" onClick={onCancel} disabled={busy}>
              取消
            </Button>
            <Button type="submit" disabled={busy}>
              创建
            </Button>
          </div>
        </form>
      </CardContent>
    </Card>
  )
}

function Field({ label, required, children }: { label: string; required?: boolean; children: React.ReactNode }) {
  return (
    <label className="space-y-1.5 block">
      <span className="text-xs text-muted-foreground">
        {label}
        {required && <span className="text-destructive ml-1">*</span>}
      </span>
      {children}
    </label>
  )
}