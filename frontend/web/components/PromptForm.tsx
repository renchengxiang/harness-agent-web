// frontend/web/components/PromptForm.tsx
"use client"

import { useState, useRef, useEffect } from "react"
import { Button } from "@/components/ui/button"
import { Textarea } from "@/components/ui/textarea"
import { Sparkles, Loader2, Send, Square } from "lucide-react"

export type ChatMode = "initial" | "running" | "ready" | "waiting" | "error"

interface Props {
  onSubmit: (prompt: string) => void
  onStop?: () => void
  loading: boolean
  /** 当前任务阶段；决定 placeholder/按钮文案/快捷按钮 */
  mode?: ChatMode
}

export function PromptForm({ onSubmit, onStop, loading, mode = "initial" }: Props) {
  const [prompt, setPrompt] = useState("")
  const textareaRef = useRef<HTMLTextAreaElement>(null)

  // 切换到非 initial 模式时聚焦输入框
  useEffect(() => {
    if (mode !== "initial" && !loading) {
      textareaRef.current?.focus()
    }
  }, [mode, loading])

  const placeholder =
    mode === "initial"  ? "描述你想生成的 PPT，例如：生成一个关于AI发展趋势的8页PPT..." :
    mode === "running"  ? "Agent 执行中…可以输入新的修改意见排队（提交后等任务暂停时发送）" :
    mode === "ready"    ? "继续提出修改意见，例如：把标题改成蓝色、增加一页总结..." :
    mode === "waiting"  ? "Agent 正在等待您的确认或修改意见..." :
                          "输入修改意见后重试..."

  const buttonLabel =
    mode === "initial" ? "开始生成 (⌘ + Enter)" : "发送 (⌘ + Enter)"

  const canSubmit = prompt.trim() && !loading

  const handleSubmit = () => {
    if (!canSubmit) return
    onSubmit(prompt.trim())
    setPrompt("")
  }

  return (
    <div className="space-y-2">
      {/* 输入区 */}
      <div className="relative flex items-end gap-2 rounded-xl border bg-background p-2 focus-within:ring-2 focus-within:ring-ring/40 transition">
        <Textarea
          ref={textareaRef}
          value={prompt}
          onChange={(e) => setPrompt(e.target.value)}
          placeholder={placeholder}
          className="flex-1 min-h-[44px] max-h-[200px] border-0 shadow-none focus-visible:ring-0 resize-none px-2 py-2 text-sm bg-transparent"
          disabled={loading && mode === "initial"}
          onKeyDown={(e) => {
            if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) {
              e.preventDefault()
              handleSubmit()
            }
          }}
        />

        <div className="flex items-center gap-1 shrink-0 pb-1 pr-1">
          {loading && onStop && (
            <Button
              variant="outline"
              size="icon"
              onClick={onStop}
              title="停止任务"
              className="h-9 w-9"
            >
              <Square className="h-3.5 w-3.5 fill-current" />
            </Button>
          )}
          <Button
            onClick={handleSubmit}
            disabled={!canSubmit}
            size="icon"
            className="h-9 w-9"
            title={buttonLabel}
          >
            {loading && mode === "initial" ? (
              <Loader2 className="h-4 w-4 animate-spin" />
            ) : mode === "initial" ? (
              <Sparkles className="h-4 w-4" />
            ) : (
              <Send className="h-4 w-4" />
            )}
          </Button>
        </div>
      </div>

      {/* 提示文字 */}
      <p className="text-[11px] text-muted-foreground px-1">
        {mode === "initial"
          ? "描述需求，Agent 会自动规划内容、设计排版并生成文件"
          : mode === "running"
          ? "执行中…可继续输入,任务暂停时会发送给 Agent"
          : "⌘/Ctrl + Enter 发送"}
      </p>
    </div>
  )
}
