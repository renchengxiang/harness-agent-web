"use client"

import { Suspense, useState, type FormEvent } from "react"
import { useRouter, useSearchParams } from "next/navigation"
import Link from "next/link"
import { Bot, LogIn } from "lucide-react"
import { Button } from "@/components/ui/button"
import { useAuth } from "@/lib/auth"

export default function LoginPage() {
  return (
    <Suspense fallback={<LoginShell><p className="text-sm text-muted-foreground">加载中…</p></LoginShell>}>
      <LoginForm />
    </Suspense>
  )
}

function LoginForm() {
  const router = useRouter()
  const params = useSearchParams()
  const { login } = useAuth()
  const [username, setUsername] = useState("admin")
  const [password, setPassword] = useState("")
  const [submitting, setSubmitting] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const handleSubmit = async (event: FormEvent) => {
    event.preventDefault()
    setSubmitting(true)
    setError(null)
    try {
      await login(username.trim(), password)
      const next = params.get("next") || "/"
      router.replace(next)
    } catch (e) {
      setError(e instanceof Error ? e.message : "登录失败")
    } finally {
      setSubmitting(false)
    }
  }

  return (
    <LoginShell>
      <form onSubmit={handleSubmit} className="mt-6 space-y-3">
        <div className="space-y-1.5">
          <label className="text-xs text-muted-foreground" htmlFor="username">用户名</label>
          <input
            id="username"
            autoComplete="username"
            className="w-full rounded-md border bg-background px-3 py-2 text-sm outline-none focus-visible:ring-2 focus-visible:ring-ring"
            value={username}
            onChange={(e) => setUsername(e.target.value)}
            required
          />
        </div>
        <div className="space-y-1.5">
          <label className="text-xs text-muted-foreground" htmlFor="password">密码</label>
          <input
            id="password"
            type="password"
            autoComplete="current-password"
            className="w-full rounded-md border bg-background px-3 py-2 text-sm outline-none focus-visible:ring-2 focus-visible:ring-ring"
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            required
          />
        </div>

        {error && (
          <p className="text-xs text-destructive">{error}</p>
        )}

        <Button type="submit" className="w-full" disabled={submitting}>
          <LogIn className="h-4 w-4 mr-1.5" />
          {submitting ? "登录中…" : "登录"}
        </Button>
      </form>

      <p className="mt-6 text-center text-xs text-muted-foreground">
        <Link href="/" className="hover:underline">← 返回首页</Link>
      </p>
    </LoginShell>
  )
}

function LoginShell({ children }: { children: React.ReactNode }) {
  return (
    <div className="flex min-h-screen items-center justify-center bg-background px-4">
      <div className="w-full max-w-sm rounded-2xl border bg-card p-8 shadow-sm">
        <div className="flex flex-col items-center gap-2">
          <div className="h-12 w-12 rounded-2xl bg-primary/10 flex items-center justify-center">
            <Bot className="h-6 w-6 text-primary" />
          </div>
          <h1 className="text-lg font-semibold">登录 Harness</h1>
          <p className="text-xs text-muted-foreground">使用管理员分配的账号登录</p>
        </div>
        {children}
      </div>
    </div>
  )
}