import { useTranslate } from '../../../i18n/index.js'
import { formatSize, getExtension } from '../../../services/attachments.js'
import { Button } from '@deepseek-chat/spine/design'
import { FileIcon } from '../../files/FileIcon.js'
import { panelStyles } from '@deepseek-chat/spine/design'
import styles from '../PreviewPanel.module.css'

/** 不支持直接内嵌预览的二进制格式占位视图 */
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
  const t = useTranslate()
  const ext = getExtension(name)
  const meta = [ext || mimeType, formatSize(size)].filter(Boolean).join(' · ')

  return (
    <div className={styles.fallbackState}>
      <div className={panelStyles.emptyIcon}>
        <FileIcon ext={ext} />
      </div>
      <div className={panelStyles.emptyTitle}>{name}</div>
      {meta ? <div className={styles.fallbackMeta}>{meta}</div> : null}
      <div className={panelStyles.emptyDesc}>
        {t(missing ? 'previewFileMissing' : 'previewBinaryDescription')}
      </div>
      {!missing && onSave ? (
        <Button variant="primary" size="m" onClick={onSave}>
          {t('previewSaveFile')}
        </Button>
      ) : null}
    </div>
  )
}
