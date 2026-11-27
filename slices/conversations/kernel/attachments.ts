import type { ModelProvider, ProviderId } from '@deepseek-chat/lib-agent'
import type { LinkedMessage, TranslationMessage } from './messages.js'
import type { FileAttachment } from './types.js'
import { ACCEPT_FILE_EXTS } from './uploadExts.js'

export const ACCEPTED_EXTS = ACCEPT_FILE_EXTS
export const ACCEPT = ACCEPTED_EXTS.map((ext) => `.${ext}`).join(',')
export const MAX_SIZE_MB = 64
export const MAX_COUNT = 50

export const getFileExt = (name: string) => {
  const dot = name.lastIndexOf('.')
  return dot > 0 ? name.slice(dot + 1).toLowerCase() : ''
}

export const isAcceptedExt = (name: string) => ACCEPTED_EXTS.includes(getFileExt(name))

const MIME_BY_EXT: Record<string, string> = {
  png: 'image/png',
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  gif: 'image/gif',
  webp: 'image/webp',
}

export const resolveMimeType = (file: File) => file.type || MIME_BY_EXT[getFileExt(file.name)] || ''

export const isImage = (mimeType: string) => mimeType.startsWith('image/')

export const getExtension = (name: string) => {
  const dot = name.lastIndexOf('.')
  return dot > 0 ? name.slice(dot + 1).toUpperCase() : ''
}

export const formatSize = (bytes: number) => {
  if (bytes < 1024) {
    return `${bytes} B`
  }
  const units = ['KB', 'MB', 'GB']
  let value = bytes / 1024
  let unit = 0
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024
    unit += 1
  }
  return `${value < 10 ? value.toFixed(1) : Math.round(value)} ${units[unit]}`
}

export const validateFiles = (
  files: File[],
  currentCount: number,
  maxSizeMBFor?: (name: string, isImageFile: boolean) => number
): TranslationMessage | null => {
  if (files.some((file) => !isAcceptedExt(file.name))) {
    return { key: 'uploadUnsupportedFormat' }
  }
  const limitFor = (file: File) =>
    maxSizeMBFor?.(file.name, isImage(resolveMimeType(file))) ?? MAX_SIZE_MB
  const oversized = files.find((file) => file.size > limitFor(file) * 1024 * 1024)
  if (oversized) {
    return { key: 'uploadMaxMBSize', params: { size: limitFor(oversized) } }
  }
  if (currentCount + files.length > MAX_COUNT) {
    return { key: 'uploadMaxFiles', params: { count: MAX_COUNT } }
  }
  return null
}

export const describeUploadError = (
  error: unknown,
  provider?: Pick<ModelProvider, 'classifyError' | 'attachments'>
): TranslationMessage => {
  if (provider?.classifyError(error) === 'serverBusy') {
    return { key: 'uploadServerBusy' }
  }
  if (provider?.attachments?.classifyUploadError(error)?.code === 'parseFailed') {
    return { key: 'uploadParseFailed' }
  }
  return { key: 'uploadFileStatusFailed' }
}

export const describeUploadQuota = (
  error: unknown,
  provider?: Pick<ModelProvider, 'attachments'>
): LinkedMessage | undefined => {
  const info = provider?.attachments?.classifyUploadError(error)
  const href = provider?.attachments?.manageFilesDocsUrl
  const link = href ? ({ key: 'uploadDeleteFiles', href } as const) : undefined
  if (info?.code === 'fileCountLimit') {
    return {
      type: 'error',
      key: 'uploadFileCountLimit',
      params: { limit: info.limit ?? '' },
      ...(link ? { link } : {}),
    }
  }
  if (info?.code === 'storageLimit') {
    return {
      type: 'error',
      key: 'uploadStorageLimit',
      params: { limit: info.limit ?? '' },
      ...(link ? { link } : {}),
    }
  }
  return undefined
}

export type UploadTask =
  | { status: 'uploading' }
  | { status: 'done'; serverId: string | null; providerId: ProviderId }
  | { status: 'error'; error: TranslationMessage; retryable: boolean }

export type UploadState = { tasks: Record<string, UploadTask> }

export type UploadsPort = {
  useUploads<T>(selector: (state: UploadState) => T): T
  getTasks(): Record<string, UploadTask>
  uploadAttachment(
    id: string,
    blob: Blob,
    name: string,
    mimeType: string,
    isImg: boolean
  ): Promise<string | null>
  cancelUpload(id: string): void
  onUploadNotice(listener: (notice: LinkedMessage) => void): () => void
  validate(files: File[], currentCount: number): TranslationMessage | null
  dispose(): void
}

export type DraftAttachment = {
  id: string
  file: File
  isImage: boolean
  previewUrl: string | null
}

export type Draft = { text: string; attachments: DraftAttachment[] }

export type DraftsState = { drafts: Map<string | null, Draft> }

export const EMPTY_DRAFT: Draft = { text: '', attachments: [] }

/** Ready to send when there is text or attachments and every attachment upload/prep has finished. */
export const prepareDraftMessage = (draft: Draft, tasks: Record<string, UploadTask>) => {
  const text = draft.text.trim()
  if (!text && draft.attachments.length === 0) {
    return null
  }
  const files: (FileAttachment & { blob: Blob })[] = []
  for (const attachment of draft.attachments) {
    const task = tasks[attachment.id]
    if (task?.status !== 'done') {
      return null
    }
    files.push({
      id: attachment.id,
      serverId: task.serverId,
      serverProvider: task.providerId,
      name: attachment.file.name,
      size: attachment.file.size,
      isImage: attachment.isImage,
      mimeType: resolveMimeType(attachment.file),
      blob: attachment.file,
    })
  }
  return { text, files }
}

export type DraftsPort = {
  useDrafts<T>(selector: (state: DraftsState) => T): T
  getDraft(sessionId: string | null): Draft
  setDraftText(sessionId: string | null, text: string): void
  addDraftFiles(sessionId: string | null, files: File[]): TranslationMessage | null
  retryDraftAttachment(sessionId: string | null, attachmentId: string): void
  removeDraftAttachment(sessionId: string | null, attachmentId: string): void
  clearSentDraft(sessionId: string | null): void
  clearDraft(sessionId: string | null): void
  clearAllDrafts(): void
}
