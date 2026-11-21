import type { Message, PresentedFileRef } from '../chat/types.js'
import { inferMimeType } from './fileKinds.js'

export type WorkspaceFileSource = 'model' | 'python' | 'upload'

export type FileVersionEntry = {
  fileId: string
  name: string
  path: string
  title: string | null
  size: number
  mimeType: string
  version: number
  source: WorkspaceFileSource
  messageId: string
  createdAt: number
}

export type WorkspaceArtifact = {
  key: string
  path: string
  name: string
  title: string | null
  mimeType: string
  source: WorkspaceFileSource
  versions: FileVersionEntry[]
  latest: FileVersionEntry
}

/** 规范化虚拟工作区路径：去掉 ./ 与前导 /，折叠多余斜杠，拦截 .. 越界 */
export const normalizeWorkspacePath = (raw: string): string => {
  const parts = raw
    .trim()
    .replace(/\\/g, '/')
    .split('/')
    .filter((seg) => seg !== '' && seg !== '.' && seg !== '..')
  return parts.join('/')
}

export const getBasename = (path: string): string => {
  const idx = path.lastIndexOf('/')
  return idx >= 0 ? path.slice(idx + 1) : path
}

export const makeArtifactKey = (path: string): string => `artifact:${normalizeWorkspacePath(path)}`

export const makeUploadPreviewKey = (fileId: string): string => `upload:${fileId}`

const inferSource = (ref: PresentedFileRef, toolName: string | undefined): WorkspaceFileSource => {
  if (ref.source) {
    return ref.source
  }
  return toolName === 'python' ? 'python' : 'model'
}

/** 从当前分支的可见消息列表派生已呈现文件及版本历史 */
export const collectWorkspaceArtifacts = (messages: Message[]): WorkspaceArtifact[] => {
  const byKey = new Map<string, WorkspaceArtifact>()
  const order: string[] = []

  for (const message of messages) {
    if (message.role !== 'assistant') {
      continue
    }
    const toolNames = new Map<string, string>()
    for (const block of message.blocks) {
      if (block.type === 'tool_use') {
        toolNames.set(block.id, block.name)
      }
    }
    for (const block of message.blocks) {
      if (block.type !== 'tool_result' || !block.files?.length) {
        continue
      }
      const toolName = toolNames.get(block.tool_use_id)
      for (const ref of block.files) {
        const path = normalizeWorkspacePath(ref.path ?? ref.name) || ref.name
        const key = makeArtifactKey(path)
        const existing = byKey.get(key)
        const version = ref.version ?? (existing ? existing.versions.length + 1 : 1)
        const entry: FileVersionEntry = {
          fileId: ref.id,
          name: ref.name || getBasename(path),
          path,
          title: ref.title ?? null,
          size: ref.size,
          mimeType: inferMimeType(ref.name || path, ref.mimeType),
          version,
          source: inferSource(ref, toolName),
          messageId: message.id,
          createdAt: message.createdAt,
        }
        if (existing) {
          existing.versions.push(entry)
          existing.latest = entry
          existing.name = entry.name
          existing.title = entry.title ?? existing.title
          existing.mimeType = entry.mimeType
          existing.source = entry.source
        } else {
          byKey.set(key, {
            key,
            path,
            name: entry.name,
            title: entry.title,
            mimeType: entry.mimeType,
            source: entry.source,
            versions: [entry],
            latest: entry,
          })
          order.push(key)
        }
      }
    }
  }

  return order.flatMap((key) => {
    const item = byKey.get(key)
    return item ? [item] : []
  })
}

/** 从可见消息收集用户上传的文件列表（按消息顺序） */
export const collectUserUploadEntries = (messages: Message[]): FileVersionEntry[] => {
  const uploads: FileVersionEntry[] = []
  for (const message of messages) {
    if (message.role !== 'user') {
      continue
    }
    for (const file of message.files) {
      uploads.push({
        fileId: file.id,
        name: file.name,
        path: file.name,
        title: null,
        size: file.size,
        mimeType: inferMimeType(file.name, file.mimeType),
        version: 1,
        source: 'upload',
        messageId: message.id,
        createdAt: message.createdAt,
      })
    }
  }
  return uploads
}

/** 解析可见消息中的文件条目（供 edit_file / read_file 查找最新版本） */
export const findWorkspaceFile = (
  messages: Message[],
  queryPath: string,
  options: { includeUploads?: boolean } = {}
): FileVersionEntry | null => {
  const normalized = normalizeWorkspacePath(queryPath)
  if (!normalized) {
    return null
  }
  const artifacts = collectWorkspaceArtifacts(messages)
  const exactArtifact = artifacts.find((a) => a.path === normalized)
  if (exactArtifact) {
    return exactArtifact.latest
  }
  const lower = normalized.toLowerCase()
  const ciArtifact = artifacts.find(
    (a) => a.path.toLowerCase() === lower || a.name.toLowerCase() === lower
  )
  if (ciArtifact) {
    return ciArtifact.latest
  }

  if (options.includeUploads) {
    const uploads = collectUserUploadEntries(messages)
    for (let i = uploads.length - 1; i >= 0; i--) {
      const entry = uploads[i]
      if (normalizeWorkspacePath(entry.path) === normalized || entry.name.toLowerCase() === lower) {
        return entry
      }
    }
  }
  return null
}
