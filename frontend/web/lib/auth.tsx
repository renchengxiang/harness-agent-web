"use client"

import { createContext, useCallback, useContext, useEffect, useMemo, useState, type ReactNode } from "react"
import { fetchMe, getAuthToken, login as apiLogin, setAuthToken, type User } from "@/lib/api"

const USER_STORAGE_KEY = "harness_user"

type AuthContextValue = {
  user: User | null
  ready: boolean
  isAdmin: boolean
  login: (username: string, password: string) => Promise<void>
  logout: () => void
  refresh: () => Promise<void>
}

const AuthContext = createContext<AuthContextValue | null>(null)

function readStoredUser(): User | null {
  if (typeof window === "undefined") return null
  const raw = localStorage.getItem(USER_STORAGE_KEY)
  if (!raw) return null
  try {
    return JSON.parse(raw) as User
  } catch {
    return null
  }
}

function persistUser(user: User | null) {
  if (typeof window === "undefined") return
  if (user) localStorage.setItem(USER_STORAGE_KEY, JSON.stringify(user))
  else localStorage.removeItem(USER_STORAGE_KEY)
}

export function AuthProvider({ children }: { children: ReactNode }) {
  // 用 useState 的初始化器在客户端首次渲染时同步读取 localStorage，
  // 避免 effect 内 setState 造成的级联渲染。
  const [user, setUser] = useState<User | null>(() => readStoredUser())
  const [ready, setReady] = useState(false)

  const refresh = useCallback(async () => {
    if (!getAuthToken()) {
      setUser(null)
      persistUser(null)
      return
    }
    try {
      const me = await fetchMe()
      setUser(me)
      persistUser(me)
    } catch {
      setAuthToken(null)
      setUser(null)
      persistUser(null)
    }
  }, [])

  useEffect(() => {
    // 进入页面时主动与后端校验 token 是否仍有效。
    refresh().finally(() => setReady(true))
  }, [refresh])

  const login = useCallback(async (username: string, password: string) => {
    const result = await apiLogin(username, password)
    setAuthToken(result.access_token)
    setUser(result.user)
    persistUser(result.user)
  }, [])

  const logout = useCallback(() => {
    setAuthToken(null)
    setUser(null)
    persistUser(null)
  }, [])

  const value = useMemo<AuthContextValue>(
    () => ({
      user,
      ready,
      isAdmin: user?.role === "admin",
      login,
      logout,
      refresh,
    }),
    [user, ready, login, logout, refresh],
  )

  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>
}

export function useAuth() {
  const ctx = useContext(AuthContext)
  if (!ctx) {
    throw new Error("useAuth 必须在 AuthProvider 内使用")
  }
  return ctx
}