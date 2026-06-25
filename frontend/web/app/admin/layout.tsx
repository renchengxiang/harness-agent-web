"use client"

import Link from "next/link"
import { usePathname, useRouter } from "next/navigation"
import { useEffect } from "react"
import { Bot, LogOut, Settings, Shield, Users } from "lucide-react"
import { useAuth } from "@/lib/auth"
import { Button } from "@/components/ui/button"
import { cn } from "@/lib/utils"

const NAV = [
  { href: "/admin", label: "概览", icon: Shield },
  { href: "/admin/users", label: "用户", icon: Users },
]

export default function AdminLayout({ children }: { children: React.ReactNode }) {
  const pathname = usePathname()
  const router = useRouter()
  const { user, ready, isAdmin, logout } = useAuth()

  useEffect(() => {
    if (!ready) return
    if (!user) {
      router.replace(`/login?next=${encodeURIComponent(pathname || "/admin")}`)
      return
    }
    if (!isAdmin) {
      router.replace("/")
    }
  }, [ready, user, isAdmin, router, pathname])

  if (!ready || !user || !isAdmin) {
    return (
      <div className="flex h-screen items-center justify-center text-sm text-muted-foreground">
        正在加载…
      </div>
    )
  }

  return (
    <div className="flex h-screen bg-background">
      <aside className="w-56 shrink-0 border-r flex flex-col">
        <div className="px-4 py-3 border-b flex items-center gap-2">
          <Bot className="h-5 w-5 text-primary" />
          <span className="font-semibold text-sm">管理后台</span>
        </div>

        <nav className="flex-1 px-2 py-3 space-y-1">
          {NAV.map((item) => {
            const Icon = item.icon
            const active = pathname === item.href
            return (
              <Link
                key={item.href}
                href={item.href}
                className={cn(
                  "flex items-center gap-2 rounded-md px-3 py-2 text-sm transition-colors",
                  active ? "bg-primary/10 text-primary" : "hover:bg-muted",
                )}
              >
                <Icon className="h-4 w-4" />
                {item.label}
              </Link>
            )
          })}
        </nav>

        <div className="border-t p-3 space-y-2">
          <p className="text-xs text-muted-foreground">已登录</p>
          <p className="text-sm font-medium">{user.display_name || user.username}</p>
          <p className="text-[11px] text-muted-foreground">角色：{user.role}</p>
          <div className="flex flex-col gap-1.5 pt-1">
            <Button asChild size="sm" variant="outline">
              <Link href="/">
                <Settings className="h-3.5 w-3.5 mr-1" />
                返回对话
              </Link>
            </Button>
            <Button size="sm" variant="ghost" onClick={() => { logout(); router.replace("/login") }}>
              <LogOut className="h-3.5 w-3.5 mr-1" />
              退出登录
            </Button>
          </div>
        </div>
      </aside>

      <main className="flex-1 overflow-y-auto">
        <div className="max-w-5xl mx-auto px-6 py-8">{children}</div>
      </main>
    </div>
  )
}