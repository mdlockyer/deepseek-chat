import { IconPhotoErrorFill20, IconRefreshOutline16, Tooltip } from '@deepseek-chat/lib-ui'
import clsx from 'clsx'
import { useEffect, useState } from 'react'
import { useConversations } from '../../context.js'
import { useTranslate, useTranslate as useConversationsTranslate } from '../../messages.js'
import { type FileAttachment } from '../../types.js'
import { FileCard } from '../files/FileCard.js'
import styles from './MessageFile.module.css'

const useNotShown = () => false

/** 原件从 BlobStore 读出并生成本地地址；undefined 表示加载中，null 表示原件缺失。 */
const useFileUrl = (id: string) => {
  const { blobs } = useConversations()
  const [fileUrl, setFileUrl] = useState<{ id: string; url: string | null } | null>(null)
  useEffect(() => {
    let objectUrl: string | null = null
    let cancelled = false
    void blobs.get(id).then((blob) => {
      if (!cancelled) {
        objectUrl = blob ? URL.createObjectURL(blob) : null
        setFileUrl({ id, url: objectUrl })
      }
    })
    return () => {
      cancelled = true
      if (objectUrl) {
        URL.revokeObjectURL(objectUrl)
      }
    }
  }, [blobs, id])
  return fileUrl?.id === id ? fileUrl.url : undefined
}

/** 历史或失效附件的补传状态：只在还没有 serverId 时显示 */
const useUploadState = (file: FileAttachment) => {
  const { uploads } = useConversations()
  return uploads.useUploads((state) => {
    if (file.serverId) {
      return null
    }
    const task = state.tasks[file.id]
    return task?.status === 'uploading' || task?.status === 'error' ? task : null
  })
}

/**
 * 消息里的附件：
 * - 图片：纯图片显示 120×120 缩略图，与文件混排时为 64×64；上传中显示 loading 蒙层，
 *   上传失败显示品牌色描边 + 中心重试图标（可重试）或 photo-error 图标（不可重试）。
 * - 文件：显示文件卡片。
 */
export const MessageFile = ({
  sessionId,
  file,
  onRetry,
}: {
  sessionId: string
  file: FileAttachment
  /** 本条消息补传失败且可重试时提供 */
  onRetry: (() => void) | null
}) => {
  const t = useTranslate()
  const tc = useConversationsTranslate()
  const { blobs, deps } = useConversations()
  const url = useFileUrl(file.id)
  const [failedUrl, setFailedUrl] = useState<string | null>(null)
  const upload = useUploadState(file)
  const uploading = upload?.status === 'uploading'
  const failed = upload?.status === 'error'
  const retryable = failed && upload.retryable
  const errorText = failed ? tc(upload.error.key, upload.error.params) : undefined
  const shownFile = { kind: 'upload', fileId: file.id } as const
  const useIsFileShown = deps.ui.useIsFileShown ?? useNotShown
  const isPreviewOpen = useIsFileShown(sessionId, shownFile)

  const retry = retryable ? onRetry : null
  const openInPreview =
    url && !upload
      ? deps.ui.openFile
        ? () => deps.ui.openFile?.(sessionId, shownFile)
        : () => {
            void blobs.get(file.id).then((blob) => {
              if (blob) {
                void deps.ui.saveFile(file.name, blob)
              }
            })
          }
      : undefined

  if (file.isImage && url !== null) {
    const preview = url ? (
      failedUrl === url ? (
        <span className={styles.failedIcon} role="img" aria-label={file.name}>
          <IconPhotoErrorFill20 />
        </span>
      ) : (
        <img src={url} alt={file.name} onError={() => setFailedUrl(url)} />
      )
    ) : null

    if (uploading) {
      return (
        <div className={clsx(styles.image, styles.imageThumb)} title={file.name}>
          {preview}
          <div className={styles.overlay}>
            <span className={styles.spinner} />
          </div>
        </div>
      )
    }

    const reason =
      errorText && errorText !== t('uploadFileStatusFailed') ? (
        <span className={styles.reason}>{errorText}</span>
      ) : null

    if (failed && !retry) {
      return (
        <div
          className={clsx(styles.image, styles.imageThumb)}
          title={errorText}
          aria-label={errorText}
        >
          {preview ?? (
            <span className={styles.failedIcon}>
              <IconPhotoErrorFill20 />
            </span>
          )}
          {reason}
        </div>
      )
    }

    if (failed && retry) {
      const retryLabel = t('uploadRetry', { message: errorText ?? t('uploadFileStatusFailed') })
      return (
        <Tooltip content={retryLabel}>
          <button
            type="button"
            className={clsx(styles.image, styles.imageThumb, styles.retryImage)}
            aria-label={retryLabel}
            onClick={retry}
          >
            {preview}
            <div className={clsx(styles.overlay, styles.retryOverlay)}>
              <IconRefreshOutline16 />
            </div>
            {reason}
          </button>
        </Tooltip>
      )
    }

    return url ? (
      <button
        type="button"
        className={clsx(styles.image, styles.imageThumb)}
        title={file.name}
        aria-label={`${t('previewActionView')}: ${file.name}`}
        onClick={openInPreview}
      >
        {preview}
      </button>
    ) : (
      <div className={styles.image} />
    )
  }

  return (
    <FileCard
      name={file.name}
      size={file.size}
      status={uploading ? 'uploading' : failed ? 'error' : 'done'}
      error={errorText}
      active={isPreviewOpen}
      onRetry={retry ?? undefined}
      onOpen={openInPreview}
    />
  )
}
