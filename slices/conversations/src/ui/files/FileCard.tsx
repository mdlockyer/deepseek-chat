import clsx from 'clsx'
import type { ReactNode } from 'react'
import { useTranslate } from '../../messages.js'
import { formatSize, getExtension } from '../../attachments.js'
import {
  IconCloseFill14,
  IconDownloadOutline16,
  IconRefreshOutline16,
} from '@deepseek-chat/spine/design'
import { FileIcon } from '@deepseek-chat/spine/design'
import styles from './FileCard.module.css'

/**
 * 统一文件卡片：图标 + 文件名/标题 + 「扩展名 大小」或状态文案。
 * 用于草稿附件、用户消息文件、Python 生成文件以及模型呈现文件。
 */
export const FileCard = ({
  name,
  title,
  size,
  subtitle,
  status = 'done',
  error,
  active = false,
  className,
  onRetry,
  onRemove,
  onOpen,
  onDownload,
}: {
  name: string
  title?: string
  size: number
  subtitle?: string
  status?: 'uploading' | 'done' | 'error'
  error?: string
  active?: boolean
  className?: string
  onRetry?: () => void
  onRemove?: () => void
  onOpen?: () => void
  onDownload?: () => void
}) => {
  const t = useTranslate()
  const ext = getExtension(name)
  let icon: ReactNode = <FileIcon ext={ext} />
  let description = subtitle ?? ([ext, formatSize(size)].filter(Boolean).join(' ') || '')
  if (status === 'uploading') {
    icon = <span className={styles.spinner} />
    description = t('uploadFileStatusUploading')
  } else if (status === 'error') {
    // 不可重试（过大、格式不支持）时保留文件图标并显示原因
    if (onRetry) {
      icon = <IconRefreshOutline16 />
    }
    description = error ?? t('uploadFileStatusFailed')
  }
  const onClick = status === 'error' ? onRetry : status === 'done' ? onOpen : undefined
  const label = title || name
  return (
    <div
      role={onClick ? 'button' : undefined}
      tabIndex={onClick ? 0 : undefined}
      className={clsx(
        styles.card,
        onRemove && styles.editable,
        status === 'error' && (onRemove || onRetry) && styles.failed,
        onClick && styles.clickable,
        active && styles.active,
        className
      )}
      title={
        status === 'error'
          ? onRetry
            ? t('uploadRetry', { message: description })
            : description
          : label
      }
      onClick={onClick}
      onKeyDown={
        onClick
          ? (event) => {
              if (event.key === 'Enter' || event.key === ' ') {
                event.preventDefault()
                onClick()
              }
            }
          : undefined
      }
    >
      <div className={clsx(styles.icon, status === 'error' && onRetry && styles.retry)}>{icon}</div>
      <div className={styles.content}>
        <div className={styles.caption}>{label}</div>
        <div className={styles.subCaption}>{description}</div>
      </div>
      {onDownload && status === 'done' ? (
        <button
          type="button"
          className={styles.downloadBtn}
          aria-label={`${t('previewSaveFile')}: ${name}`}
          title={t('previewSaveFile')}
          onClick={(event) => {
            event.stopPropagation()
            onDownload()
          }}
        >
          <IconDownloadOutline16 />
        </button>
      ) : null}
      {onRemove ? (
        <button
          type="button"
          className={clsx(styles.remove, status === 'error' && !onRetry && styles.invalidRemove)}
          aria-label={t('delete')}
          onClick={(event) => {
            event.stopPropagation()
            onRemove()
          }}
        >
          <IconCloseFill14 />
        </button>
      ) : null}
    </div>
  )
}
