// frontend/web/components/ResultBar.tsx
"use client"

import { Button } from "@/components/ui/button"
import { Download, CheckCircle2, XCircle } from "lucide-react"
import { getDownloadUrl } from "@/lib/api"

interface Props {
  taskId: string
  status: "done" | "error"
  outputFile?: string
  error?: string
}

export function ResultBar({ taskId, status, outputFile, error }: Props) {
  if (status === "error") {
    return (
      <div className="flex items-center gap-3 p-4 rounded-lg border border-red-200 bg-red-50 dark:bg-red-950/20">
        <XCircle className="h-5 w-5 text-red-500 shrink-0" />
        <div className="flex-1 min-w-0">
          <p className="font-medium text-red-700 dark:text-red-400">生成失败</p>
          {error && (
            <p className="text-sm text-red-600/70 truncate">{error}</p>
          )}
        </div>
      </div>
    )
  }

  return (
    <div className="flex items-center gap-3 p-4 rounded-lg border border-green-200 bg-green-50 dark:bg-green-950/20">
      <CheckCircle2 className="h-5 w-5 text-green-500 shrink-0" />
      <div className="flex-1 min-w-0">
        <p className="font-medium text-green-700 dark:text-green-400">
          PPT 生成完成！
        </p>
        {outputFile && (
          <p className="text-xs text-green-600/70 truncate font-mono">
            {outputFile}
          </p>
        )}
      </div>
      {outputFile && (
        <Button size="sm" className="shrink-0" asChild>
          <a href={getDownloadUrl(taskId)} download>
            <Download className="mr-2 h-4 w-4" />
            下载 PPT
          </a>
        </Button>
      )}
    </div>
  )
}