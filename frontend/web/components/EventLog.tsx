// frontend/web/components/EventLog.tsx
"use client"

import { useEffect, useRef, useState } from "react"
import { Badge } from "@/components/ui/badge"
import { CheckCircle2, XCircle, Loader2, Terminal, ChevronDown, ChevronRight, Code, User } from "lucide-react"
import { AgentEvent } from "@/lib/api"

interface LogItem {
  id: string
  type: "assistant" | "tool" | "user"
  content: string
  detail?: string      // tool_input 或 tool_output
  status?: "running" | "done" | "error"
}

interface Props {
  events: AgentEvent[]
  /** 是否在容器内自适应高度（聊天流模式）；false 时使用固定高度（兼容旧布局） */
  fluid?: boolean
}

// 把原始事件流转换为可读日志条目
function eventsToLogs(events: AgentEvent[]): LogItem[] {
  const logs: LogItem[] = []
  let idCounter = 0
  for (const event of events) {
    const id = String(idCounter++)

    if (event.type === "user_message") {
      logs.push({ id, type: "user", content: event.text })
    } else if (event.type === "assistant_delta") {
      // 合并到上一条 assistant 消息，避免每个字都新建一行
      const last = logs[logs.length - 1]
      if (last?.type === "assistant") {
        last.content += event.text
        continue
      }
      logs.push({ id, type: "assistant", content: event.text })
    } else if (event.type === "assistant_complete" && event.text.trim()) {
      // 完整的助理消息：尝试与上一条已累积的 delta 合并，避免重复渲染。
      // oh 的 stream-json 里，assistant_complete 经常携带"完整/最终"文本，而
      // 之前已经有一串 assistant_delta 被合并到了 last.content。两者关系有 4 种：
      const last = logs[logs.length - 1]
      const text = event.text
      if (last?.type === "assistant") {
        if (last.content === text) {
          // 完全相同：complete 只是确认 → 跳过
          continue
        }
        const lastTrim = last.content.trimEnd()
        if (lastTrim === text.trimEnd()) {
          // 仅尾部空白不同
          last.content = text
          continue
        }
        if (text.startsWith(lastTrim)) {
          // text 包含 last 的全部内容 + 尾巴（complete 把之前漏发的 token 补全了）
          last.content = text
          continue
        }
        if (lastTrim.startsWith(text.trimEnd())) {
          // last 已经包含了 text 的全部（delta 流式发送时把完整文本发出去了）
          continue
        }
        // 完全不同（可能是新一轮回复开始、或上一条其实是不同 step）→ 新建一条
      }
      logs.push({ id, type: "assistant", content: text })
    } else if (event.type === "tool_started") {
      // 格式化工具输入
      let detail = ""
      if (event.tool_input) {
        const input = event.tool_input
        if (typeof input === "object") {
          // bash 命令特别显示
          if (input.command) {
            detail = `$ ${input.command}`
          } else if (input.content) {
            // write_file 等 - 显示截断的内容
            const content = String(input.content)
            detail = content.length > 500
              ? content.slice(0, 500) + "\n... (已截断)"
              : content
          } else {
            detail = JSON.stringify(input, null, 2)
          }
        } else {
          detail = String(input)
        }
      }
      logs.push({
        id,
        type: "tool",
        content: event.tool_name,
        detail,
        status: "running",
      })
    } else if (event.type === "tool_completed") {
      // 找到对应的 tool_started，更新状态和输出
      const target = [...logs].reverse().find(
        (l) => l.type === "tool" && l.content === event.tool_name && l.status === "running"
      )
      if (target) {
        target.status = event.is_error ? "error" : "done"
        // 保存输出详情
        if (event.output) {
          const output = String(event.output)
          target.detail = (target.detail ? target.detail + "\n\n" : "") +
            "── 输出 ──\n" +
            (output.length > 1000 ? output.slice(0, 1000) + "\n... (已截断)" : output)
        }
      }
    }
  }
  return logs
}

export function EventLog({ events, fluid = false }: Props) {
  const bottomRef = useRef<HTMLDivElement>(null)
  // 自动滚动到底部
  useEffect(() => {
    bottomRef.current?.scrollIntoView({ behavior: "smooth", block: "end" })
  }, [events])

  const logs = eventsToLogs(events)

  if (logs.length === 0) {
    return (
      <div className="flex flex-col items-center justify-center h-40 text-muted-foreground gap-2">
        <Terminal className="h-8 w-8 opacity-30" />
        <p className="text-sm">等待任务开始...</p>
      </div>
    )
  }

  // fluid: 由外部容器控制滚动；否则保留旧的固定高度
  const wrapper = fluid
    ? "space-y-2 font-mono text-sm"
    : "space-y-1 font-mono text-sm rounded-md border bg-muted/30 p-4 max-h-[400px] overflow-y-auto"

  return (
    <div className={wrapper}>
      {logs.map((log) => (
        <LogLine key={log.id} log={log} />
      ))}
      <div ref={bottomRef} />
    </div>
  )
}

function LogLine({ log }: { log: LogItem }) {
  if (log.type === "user")  return <UserLogLine content={log.content} />
  if (log.type === "tool")  return <ToolLogLine log={log} />
  // Agent 思考/回复文字
  return (
    <div className="text-foreground/85 leading-relaxed whitespace-pre-wrap py-1">
      {log.content}
    </div>
  )
}

function UserLogLine({ content }: { content: string }) {
  return (
    <div className="flex justify-end my-2">
      <div className="max-w-[85%] flex items-start gap-2">
        <div className="rounded-2xl rounded-tr-sm bg-primary text-primary-foreground px-3 py-2 text-sm whitespace-pre-wrap break-words shadow-sm">
          {content}
        </div>
        <div className="h-7 w-7 shrink-0 rounded-full bg-primary/15 flex items-center justify-center">
          <User className="h-3.5 w-3.5 text-primary" />
        </div>
      </div>
    </div>
  )
}

function ToolLogLine({ log }: { log: LogItem }) {
  const [expanded, setExpanded] = useState(false)
  const hasDetail = !!log.detail

  return (
    <div className="border-l-2 border-muted-foreground/20 pl-3 py-1 space-y-1">
      {/* 标题行 */}
      <div
        className="flex items-center gap-2 cursor-pointer select-none"
        onClick={() => hasDetail && setExpanded(!expanded)}
      >
        {/* 展开/折叠图标 */}
        {hasDetail ? (
          expanded ? <ChevronDown className="h-3 w-3 shrink-0 text-muted-foreground" />
                    : <ChevronRight className="h-3 w-3 shrink-0 text-muted-foreground" />
        ) : (
          <span className="w-3 shrink-0" />
        )}

        {/* 状态图标 */}
        {log.status === "running" && (
          <Loader2 className="h-3.5 w-3.5 text-blue-500 animate-spin shrink-0" />
        )}
        {log.status === "done" && (
          <CheckCircle2 className="h-3.5 w-3.5 text-green-500 shrink-0" />
        )}
        {log.status === "error" && (
          <XCircle className="h-3.5 w-3.5 text-red-500 shrink-0" />
        )}

        {/* 工具名 */}
        <Badge
          variant="outline"
          className="text-xs px-1.5 py-0 h-5 font-mono"
        >
          <Code className="h-3 w-3 mr-1" />
          {log.content}
        </Badge>

        <span className="text-muted-foreground text-xs">
          {log.status === "running" ? "执行中..." :
           log.status === "done"    ? "完成" : "失败"}
        </span>
      </div>

      {/* 详情（展开时显示） */}
      {expanded && hasDetail && (
        <div className="ml-7 p-2 rounded bg-background/80 border text-xs overflow-x-auto">
          <pre className="whitespace-pre-wrap break-all">{log.detail}</pre>
        </div>
      )}
    </div>
  )
}
