import { inferMimeType } from './fileKinds.js'

export type WorkspaceFileSource = 'model' | 'python' | 'upload'

/**
 * One file as the conversation knows it, in conversation order: a file a tool presented in a
 * reply, or a file the user attached. The app derives these from the visible branch.
 */
export type FileRecord =
  | {
      readonly kind: 'presented'
      readonly fileId: string
      readonly name: string
      /** Logical workspace path; versions of one path form one artifact. */
      readonly path?: string
      readonly title?: string
      readonly size: number
      readonly mimeType: string
      readonly version?: number
      readonly source?: 'model' | 'python'
      /** Name of the tool whose result carried the file. */
      readonly producedBy?: string
      readonly messageId: string
      readonly createdAt: number
    }
  | {
      readonly kind: 'upload'
      readonly fileId: string
      readonly name: string
      readonly size: number
      readonly mimeType: string
      readonly messageId: string
      readonly createdAt: number
    }

type PresentedRecord = Extract<FileRecord, { kind: 'presented' }>

/** A file presented by a tool, as stored in the reply (the app keeps it in the chat). */
export type PresentedFile = {
  id: string
  name: string
  size: number
  mimeType: string
  path?: string
  title?: string
  version?: number
  source?: 'model' | 'python'
}

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

const inferSource = (record: PresentedRecord): WorkspaceFileSource => {
  if (record.source) {
    return record.source
  }
  return record.producedBy === 'python' ? 'python' : 'model'
}

/** 从当前分支的文件记录派生已呈现文件及版本历史 */
export const collectWorkspaceArtifacts = (records: readonly FileRecord[]): WorkspaceArtifact[] => {
  const byKey = new Map<string, WorkspaceArtifact>()
  const order: string[] = []

  for (const ref of records) {
    if (ref.kind !== 'presented') {
      continue
    }
    const path = normalizeWorkspacePath(ref.path ?? ref.name) || ref.name
    const key = makeArtifactKey(path)
    const existing = byKey.get(key)
    const version = ref.version ?? (existing ? existing.versions.length + 1 : 1)
    const entry: FileVersionEntry = {
      fileId: ref.fileId,
      name: ref.name || getBasename(path),
      path,
      title: ref.title ?? null,
      size: ref.size,
      mimeType: inferMimeType(ref.name || path, ref.mimeType),
      version,
      source: inferSource(ref),
      messageId: ref.messageId,
      createdAt: ref.createdAt,
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

  return order.flatMap((key) => {
    const item = byKey.get(key)
    return item ? [item] : []
  })
}

/** 收集用户上传的文件列表（按对话顺序） */
export const collectUserUploadEntries = (records: readonly FileRecord[]): FileVersionEntry[] =>
  records.flatMap((file) =>
    file.kind === 'upload'
      ? [
          {
            fileId: file.fileId,
            name: file.name,
            path: file.name,
            title: null,
            size: file.size,
            mimeType: inferMimeType(file.name, file.mimeType),
            version: 1,
            source: 'upload' as const,
            messageId: file.messageId,
            createdAt: file.createdAt,
          },
        ]
      : []
  )

/** 解析文件记录中的文件条目（供 edit_file / read_file 查找最新版本） */
export const findWorkspaceFile = (
  records: readonly FileRecord[],
  queryPath: string,
  options: { includeUploads?: boolean } = {}
): FileVersionEntry | null => {
  const normalized = normalizeWorkspacePath(queryPath)
  if (!normalized) {
    return null
  }
  const artifacts = collectWorkspaceArtifacts(records)
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
    const uploads = collectUserUploadEntries(records)
    for (let i = uploads.length - 1; i >= 0; i--) {
      const entry = uploads[i]
      if (normalizeWorkspacePath(entry.path) === normalized || entry.name.toLowerCase() === lower) {
        return entry
      }
    }
  }
  return null
}
