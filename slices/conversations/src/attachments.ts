import type { ModelProvider, ProviderId } from '@deepseek-chat/lib-agent'
import { isRetryableApiError } from '@deepseek-chat/lib-agent'
import { create } from 'zustand'
import type { LinkedMessage, TranslationMessage } from './messages.js'
import { ACCEPT_FILE_EXTS } from './uploadExts.js'

export const ACCEPTED_EXTS = ACCEPT_FILE_EXTS
export const ACCEPT = ACCEPTED_EXTS.map((ext) => `.${ext}`).join(',')
export const MAX_SIZE_MB = 64
export const MAX_COUNT = 50
const MAX_CONCURRENT = 3

export const getFileExt = (name: string) => {
  const dot = name.lastIndexOf('.')
  return dot > 0 ? name.slice(dot + 1).toLowerCase() : ''
}

export const isAcceptedExt = (name: string) => ACCEPTED_EXTS.includes(getFileExt(name))

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

type UploadState = { tasks: Record<string, UploadTask> }
type NoticeListener = (notice: LinkedMessage) => void

export const createUploadsController = (provider: ModelProvider) => {
  const useUploads = create<UploadState>(() => ({ tasks: {} }))
  const noticeListeners = new Set<NoticeListener>()
  const queue: (() => Promise<void>)[] = []
  let running = 0
  const pending = new Map<
    string,
    { promise: Promise<string | null>; controller: AbortController }
  >()

  const next = () => {
    while (running < MAX_CONCURRENT) {
      const job = queue.shift()
      if (!job) {
        return
      }
      running += 1
      void job().finally(() => {
        running -= 1
        next()
      })
    }
  }

  const enqueueUpload = (
    id: string,
    file: Blob,
    name: string,
    mimeType: string,
    isImg: boolean,
    signal: AbortSignal
  ) =>
    new Promise<string>((resolve, reject) => {
      const attachmentPort = provider.attachments
      if (!attachmentPort) {
        reject(new Error('Active provider does not support remote uploads.'))
        return
      }
      queue.push(async () => {
        if (signal.aborted) {
          reject(signal.reason)
          return
        }
        try {
          resolve(
            await attachmentPort.upload({ id, blob: file, name, mimeType, isImage: isImg }, signal)
          )
        } catch (error) {
          reject(error)
        }
      })
      next()
    })

  const setTask = (id: string, task: UploadTask | null) =>
    useUploads.setState((state) => ({
      tasks: task
        ? { ...state.tasks, [id]: task }
        : Object.fromEntries(Object.entries(state.tasks).filter(([key]) => key !== id)),
    }))

  const uploadAttachment = (
    id: string,
    blob: Blob,
    name: string,
    mimeType: string,
    isImg: boolean
  ): Promise<string | null> => {
    // Providers without a remote Files API inline blobs from BlobStore at send time.
    if (!provider.attachments) {
      setTask(id, { status: 'done', serverId: null, providerId: provider.id })
      return Promise.resolve(null)
    }
    const current = pending.get(id)
    if (current) {
      return current.promise
    }
    const controller = new AbortController()
    setTask(id, { status: 'uploading' })
    const promise = enqueueUpload(id, blob, name, mimeType, isImg, controller.signal)
      .then((serverId) => {
        setTask(id, { status: 'done', serverId, providerId: provider.id })
        return serverId
      })
      .catch((error: unknown) => {
        if (controller.signal.aborted) {
          setTask(id, null)
        } else {
          setTask(id, {
            status: 'error',
            error: describeUploadError(error, provider),
            retryable: isRetryableApiError(error),
          })
          const notice = describeUploadQuota(error, provider)
          if (notice) {
            for (const listener of [...noticeListeners]) {
              listener(notice)
            }
          }
        }
        throw error
      })
      .finally(() => pending.delete(id))
    pending.set(id, { promise, controller })
    return promise
  }

  const cancelUpload = (id: string) => {
    pending.get(id)?.controller.abort()
    setTask(id, null)
  }

  const onUploadNotice = (listener: NoticeListener) => {
    noticeListeners.add(listener)
    return () => {
      noticeListeners.delete(listener)
    }
  }

  const dispose = () => {
    for (const item of pending.values()) {
      item.controller.abort()
    }
    pending.clear()
    queue.length = 0
    noticeListeners.clear()
    useUploads.setState({ tasks: {} })
  }

  return {
    useUploads,
    uploadAttachment,
    cancelUpload,
    onUploadNotice,
    validate: (files: File[], currentCount: number) =>
      validateFiles(files, currentCount, provider.attachments?.maxFileSizeMB),
    dispose,
  }
}

export type UploadsController = ReturnType<typeof createUploadsController>

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
