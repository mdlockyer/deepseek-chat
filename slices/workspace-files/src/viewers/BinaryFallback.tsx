import { Button, EmptyState } from '@deepseek-chat/lib-ui'
import { useWorkspace } from '../context.js'
import { formatSize, getExtension } from '../format.js'
import { workspaceMessages } from '../messages.js'
import styles from '../PreviewPanel.module.css'

const FileIcon = ({ ext }: { ext: string }) => {
  const { FileIcon: Icon } = useWorkspace().views
  return <Icon ext={ext} />
}

export const BinaryFallback = ({
  name,
  size,
  mimeType,
  missing,
  onSave,
}: {
  name: string
  size: number
  mimeType: string
  missing?: boolean
  onSave?: () => void
}) => {
  const t = workspaceMessages.useTranslate()
  const ext = getExtension(name)
  const meta = [ext || mimeType, formatSize(size)].filter(Boolean).join(' · ')

  return (
    <div className={styles.fallbackState}>
      <EmptyState
        icon={<FileIcon ext={ext} />}
        title={name}
        description={
          <>
            {meta ? <div className={styles.fallbackMeta}>{meta}</div> : null}
            <div>{t(missing ? 'previewFileMissing' : 'previewBinaryDescription')}</div>
          </>
        }
        action={
          !missing && onSave ? (
            <Button variant="primary" size="m" onClick={onSave}>
              {t('previewSaveFile')}
            </Button>
          ) : undefined
        }
      />
    </div>
  )
}
