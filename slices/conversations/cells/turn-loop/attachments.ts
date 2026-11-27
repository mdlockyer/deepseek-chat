import { isRetryableApiError, type ModelProvider } from '@deepseek-chat/lib-agent'
import { create } from 'zustand'
import {
  describeUploadError,
  describeUploadQuota,
  validateFiles,
  type LinkedMessage,
  type UploadState,
  type UploadTask,
  type UploadsPort,
} from '../../kernel/index.js'

const MAX_CONCURRENT = 3

type NoticeListener = (notice: LinkedMessage) => void

export const createUploadsController = (provider: ModelProvider): UploadsPort => {
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
    getTasks: () => useUploads.getState().tasks,
    uploadAttachment,
    cancelUpload,
    onUploadNotice,
    validate: (files: File[], currentCount: number) =>
      validateFiles(files, currentCount, provider.attachments?.maxFileSizeMB),
    dispose,
  }
}

export type UploadsController = UploadsPort
