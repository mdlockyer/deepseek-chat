import { IconCloseFill14, IconRefreshOutline16, Tooltip } from '@deepseek-chat/lib-ui'
import clsx from 'clsx'
import { memo } from 'react'
import { type UploadTask } from '../../attachments.js'
import { useConversations } from '../../context.js'
import { type DraftAttachment } from '../../drafts.js'
import { useTranslate, useTranslate as useConversationsTranslate } from '../../messages.js'
import { FileCard } from '../files/FileCard.js'
import styles from './ChatInput.module.css'

const UPLOADING: UploadTask = { status: 'uploading' }

/** 列表只随草稿附件变化更新；每张卡片独立订阅自己的上传状态。 */
export const DraftAttachments = memo(function DraftAttachments({
  items,
  onRetry,
  onRemove,
}: {
  items: DraftAttachment[]
  onRetry: (id: string) => void
  onRemove: (id: string) => void
}) {
  if (items.length === 0) {
    return null
  }
  return (
    <div className={styles.attachments}>
      {items.map((item) => (
        <AttachmentItem
          key={item.id}
          item={item}
          onRetry={() => onRetry(item.id)}
          onRemove={() => onRemove(item.id)}
        />
      ))}
    </div>
  )
})

const AttachmentItem = ({
  item,
  onRetry,
  onRemove,
}: {
  item: DraftAttachment
  onRetry: () => void
  onRemove: () => void
}) => {
  const t = useTranslate()
  const tc = useConversationsTranslate()
  const { uploads } = useConversations()
  const task = uploads.useUploads((state) => state.tasks[item.id] ?? UPLOADING)
  const status = task.status
  const error = task.status === 'error' ? tc(task.error.key, task.error.params) : undefined
  const retry = task.status === 'error' && task.retryable ? onRetry : undefined
  const failed = status === 'error'
  const retryLabel = t('uploadRetry', { message: error ?? t('uploadFileStatusFailed') })
  const showReason = failed && error !== undefined && error !== t('uploadFileStatusFailed')
  return item.previewUrl ? (
    <div
      className={clsx(styles.attachment, failed && styles.attachmentFailed)}
      title={error ?? item.file.name}
    >
      <img src={item.previewUrl} alt={item.file.name} />
      {status === 'uploading' ? <div className={styles.uploading} /> : null}
      {failed && retry ? (
        <Tooltip content={retryLabel}>
          <button type="button" className={styles.failed} aria-label={retryLabel} onClick={retry}>
            <IconRefreshOutline16 />
            {showReason ? <span className={styles.failedReason}>{error}</span> : null}
          </button>
        </Tooltip>
      ) : null}
      {failed && !retry ? (
        <div className={clsx(styles.failed, styles.failedStatic)} aria-label={error}>
          {showReason ? <span className={styles.failedReason}>{error}</span> : null}
        </div>
      ) : null}
      <button
        type="button"
        className={clsx(styles.remove, failed && !retry && styles.invalidRemove)}
        aria-label={t('delete')}
        onClick={onRemove}
      >
        <IconCloseFill14 />
      </button>
    </div>
  ) : (
    <FileCard
      name={item.file.name}
      size={item.file.size}
      status={status}
      error={error}
      onRetry={retry}
      onRemove={onRemove}
    />
  )
}
