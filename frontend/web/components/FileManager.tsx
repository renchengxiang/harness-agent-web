// frontend/web/components/FileManager.tsx
"use client"

import { useState, useCallback, useEffect } from "react"
import { Button } from "@/components/ui/button"
import { ScrollArea } from "@/components/ui/scroll-area"
import {
  X, Folder, File, ChevronDown, ChevronRight, Upload, Save,
  FileText, Image, RefreshCw, FileJson, Loader2, Download, Eye, ExternalLink
} from "lucide-react"
import {
  getFsTree, readFile, writeFile, uploadFile, getDownloadUrl, startPreview,
  FileNode, FileContent
} from "@/lib/api"

interface Props {
  taskId: string
  open: boolean
  onClose: () => void
}

export function FileManager({ taskId, open, onClose }: Props) {
  const [rootChildren, setRootChildren] = useState<FileNode[] | null>(null)
  const [childrenCache, setChildrenCache] = useState<Record<string, FileNode[]>>({})
  const [loading, setLoading] = useState(false)
  const [selectedFile, setSelectedFile] = useState<string | null>(null)
  const [fileContent, setFileContent] = useState<FileContent | null>(null)
  const [editContent, setEditContent] = useState<string>("")
  const [isEditing, setIsEditing] = useState(false)
  const [expandedDirs, setExpandedDirs] = useState<Set<string>>(new Set())
  const [uploading, setUploading] = useState(false)
  const [previewFile, setPreviewFile] = useState<{ path: string; content: string; url: string } | null>(null)
  const [previewUrl, setPreviewUrl] = useState<string | null>(null)
  const [previewProject, setPreviewProject] = useState<string | null>(null)
  const [previewLoading, setPreviewLoading] = useState(false)

  // 加载根目录
  const loadRoot = useCallback(async () => {
    setLoading(true)
    try {
      const data = await getFsTree(taskId, "")
      if (data.children) {
        setRootChildren(data.children)
        setChildrenCache({})  // 清空缓存
      }
    } catch (e) { console.error("load tree error", e) }
    setLoading(false)
  }, [taskId])

  // 加载子目录
  const loadChildren = useCallback(async (dirPath: string) => {
    if (childrenCache[dirPath]) return  // 已缓存
    try {
      const data = await getFsTree(taskId, dirPath)
      if (data.children) {
        setChildrenCache(prev => ({ ...prev, [dirPath]: data.children! }))
      }
    } catch (e) { console.error("load children error", e, dirPath) }
  }, [taskId, childrenCache])

  useEffect(() => { if (open) loadRoot() }, [open, loadRoot])

  // 展开/收起目录
  const toggleDir = useCallback((dirPath: string) => {
    setExpandedDirs(prev => {
      const next = new Set(prev)
      if (next.has(dirPath)) {
        next.delete(dirPath)
      } else {
        next.add(dirPath)
        // lazy load
        if (!childrenCache[dirPath]) {
          loadChildren(dirPath)
        }
      }
      return next
    })
  }, [childrenCache, loadChildren])

  // 打开文件
  const openFile = useCallback(async (filePath: string) => {
    setSelectedFile(filePath)
    setFileContent(null)
    setIsEditing(false)
    try {
      const content = await readFile(taskId, filePath)
      setFileContent(content)
      setEditContent(content.content ?? "")
    } catch (e) { console.error("read error", e) }
  }, [taskId])

  // 保存文件
  const handleSave = useCallback(async () => {
    if (!selectedFile) return
    const result = await writeFile(taskId, selectedFile, editContent)
    if (result.ok) {
      setIsEditing(false)
      const content = await readFile(taskId, selectedFile)
      setFileContent(content)
      setEditContent(content.content ?? "")
    }
  }, [taskId, selectedFile, editContent])

  // 上传文件
  const handleUpload = useCallback(async (e: React.ChangeEvent<HTMLInputElement>) => {
    const files = e.target.files
    if (!files?.length) return
    setUploading(true)
    // 上传到当前打开的目录（如果展开了某个目录），否则上传到根
    const uploadDir = Array.from(expandedDirs).pop() || ""
    for (const file of Array.from(files)) await uploadFile(taskId, file, uploadDir)
    // 刷新相关目录
    if (uploadDir) {
      const data = await getFsTree(taskId, uploadDir)
      if (data.children) {
        setChildrenCache(prev => ({ ...prev, [uploadDir]: data.children! }))
      }
    } else {
      loadRoot()
    }
    setUploading(false)
    e.target.value = ""
  }, [taskId, loadRoot, expandedDirs])

  // 启动 SVG 浏览器预览（ppt-master 的 svg_editor）
  const handleStartPreview = useCallback(async () => {
    setPreviewLoading(true)
    try {
      const result = await startPreview(taskId)
      if (result.ok && result.url) {
        setPreviewUrl(result.url)
        setPreviewProject(result.project || "")
        // 在新窗口打开
        window.open(result.url, "_blank", "noopener,noreferrer")
        if (result.already_running) {
          // 已经运行
        }
      } else {
        alert(`启动预览失败: ${result.error || "未知错误"}`)
      }
    } catch (e) {
      console.error("启动预览失败", e)
      alert("启动预览失败")
    }
    setPreviewLoading(false)
  }, [taskId])

  if (!open) return null

  // 渲染树节点（递归）
  const renderNode = (node: FileNode, depth: number = 0) => {
    const isExpanded = expandedDirs.has(node.path)
    const isSelected = selectedFile === node.path
    const ext = node.name.split(".").pop()?.toLowerCase()
    const children = childrenCache[node.path]
    const isLoading = isExpanded && !children

    return (
      <div key={node.path}>
        <div
          className={`flex items-center gap-1 py-0.5 px-2 rounded cursor-pointer text-sm hover:bg-muted/50 ${isSelected ? "bg-muted font-medium" : ""}`}
          style={{ paddingLeft: `${depth * 16 + 8}px` }}
          onClick={() => {
            if (node.type === "directory") toggleDir(node.path)
            else openFile(node.path)
          }}
        >
          {node.type === "directory" ? (
            <>
              {isLoading ? (
                <Loader2 className="h-3 w-3 shrink-0 text-muted-foreground animate-spin" />
              ) : isExpanded ? (
                <ChevronDown className="h-3 w-3 shrink-0 text-muted-foreground" />
              ) : (
                <ChevronRight className="h-3 w-3 shrink-0 text-muted-foreground" />
              )}
              <Folder className="h-3.5 w-3.5 text-blue-500 shrink-0" />
            </>
          ) : (
            <><span className="w-3 shrink-0" />
              {ext === "svg" ? <Image className="h-3.5 w-3.5 text-orange-500 shrink-0" /> :
               ext === "json" ? <FileJson className="h-3.5 w-3.5 text-yellow-500 shrink-0" /> :
               ext === "md" || ext === "txt" ? <FileText className="h-3.5 w-3.5 text-sky-500 shrink-0" /> :
               <File className="h-3.5 w-3.5 text-muted-foreground shrink-0" />}</>
          )}
          <span className="truncate text-xs">{node.name}</span>
          {node.type === "file" && node.size !== undefined && (
            <span className="text-[10px] text-muted-foreground ml-auto">{fmtSize(node.size)}</span>
          )}
        </div>
        {node.type === "directory" && isExpanded && children && (
          <div>
            {children.map(child => renderNode(child, depth + 1))}
          </div>
        )}
      </div>
    )
  }

  return (
    <div className="fixed inset-y-0 right-0 w-[480px] bg-background border-l shadow-xl z-50 flex flex-col">
      {/* 头部 */}
      <div className="flex items-center justify-between px-4 py-3 border-b shrink-0">
        <h2 className="text-sm font-semibold flex items-center gap-2">
          <Folder className="h-4 w-4" />
          任务文件
          {previewUrl && (
            <a
              href={previewUrl}
              target="_blank"
              rel="noopener noreferrer"
              className="ml-1 text-[10px] text-blue-500 hover:underline flex items-center gap-0.5 font-normal"
            >
              <Eye className="h-3 w-3" />{previewUrl.replace("http://", "")}
            </a>
          )}
        </h2>
        <div className="flex items-center gap-1">
          <Button variant="ghost" size="icon" className="h-7 w-7" onClick={loadRoot} title="刷新">
            <RefreshCw className={`h-3.5 w-3.5 ${loading ? "animate-spin" : ""}`} />
          </Button>
          <label className="cursor-pointer">
            <Button variant="ghost" size="icon" className="h-7 w-7" asChild title="上传到当前目录">
              <span>{uploading ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Upload className="h-3.5 w-3.5" />}</span>
            </Button>
            <input type="file" className="hidden" multiple onChange={handleUpload} />
          </label>
          <Button variant="ghost" size="icon" className="h-7 w-7" onClick={onClose}>
            <X className="h-3.5 w-3.5" />
          </Button>
        </div>
      </div>

      {/* 内容 */}
      <div className="flex flex-1 min-h-0">
        {/* 左侧文件树 */}
        <div className="w-1/2 border-r overflow-hidden flex flex-col">
          <div className="px-3 py-1.5 text-[10px] text-muted-foreground font-medium uppercase tracking-wider border-b shrink-0">
            文件列表
          </div>
          <ScrollArea className="flex-1">
            <div className="py-1">
              {rootChildren?.map(node => renderNode(node))}
              {rootChildren?.length === 0 && <p className="text-xs text-muted-foreground text-center py-8">空目录</p>}
            </div>
          </ScrollArea>
        </div>

        {/* 右侧文件内容 */}
        <div className="w-1/2 overflow-hidden flex flex-col">
          {selectedFile ? (
            <>
              <div className="flex items-center justify-between px-3 py-1.5 border-b shrink-0">
                <span className="text-[10px] text-muted-foreground font-mono truncate">
                  {selectedFile.split("/").pop()}
                </span>
                <div className="flex items-center gap-1">
                  {fileContent?.binary ? (
                    <a href={getDownloadUrl(taskId, selectedFile.split("/").pop())} download>
                      <Button variant="ghost" size="icon" className="h-6 w-6" title="下载"><Download className="h-3 w-3" /></Button>
                    </a>
                  ) : (
                    isEditing ? (
                      <><Button variant="ghost" size="sm" className="h-6 text-xs" onClick={handleSave}><Save className="h-3 w-3 mr-1" />保存</Button>
                        <Button variant="ghost" size="sm" className="h-6 text-xs" onClick={() => setIsEditing(false)}>取消</Button></>
                    ) : (
                      <Button variant="ghost" size="sm" className="h-6 text-xs" onClick={() => setIsEditing(true)}>编辑</Button>
                    )
                  )}
                </div>
              </div>
              <ScrollArea className="flex-1">
                {fileContent?.binary ? (
                  <div className="flex items-center justify-center h-full text-xs text-muted-foreground">二进制文件</div>
                ) : isEditing ? (
                  <textarea
                    className="w-full min-h-[300px] p-3 font-mono text-xs bg-background resize-none focus:outline-none border-0"
                    value={editContent}
                    onChange={e => setEditContent(e.target.value)}
                    spellCheck={false}
                  />
                ) : (
                  <pre className="p-3 font-mono text-xs whitespace-pre-wrap break-all">{fileContent?.content}</pre>
                )}
              </ScrollArea>
            </>
          ) : (
            <div className="flex items-center justify-center h-full text-xs text-muted-foreground">
              选择文件查看内容
            </div>
          )}
        </div>
      </div>
    </div>
  )
}

function fmtSize(bytes: number): string {
  if (bytes < 1024) return `${bytes}B`
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)}KB`
  return `${(bytes / (1024 * 1024)).toFixed(1)}MB`
}
