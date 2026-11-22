import { workspaceMessages } from '../messages.js'
import { useWorkspace } from '../context.js'
import styles from '../PreviewPanel.module.css'
import { NativePreviewSurface } from './NativePreviewSurface.js'

/** PDF 预览：桌面端经隔离原生子 Webview 渲染，网页端使用浏览器内建 PDF iframe */
export const PdfPreview = ({
  blobUrl,
  bytes,
  name,
  reloadKey,
  onSave,
}: {
  blobUrl: string
  bytes: Uint8Array
  name: string
  reloadKey: number
  onSave: () => void
}) => {
  const t = workspaceMessages.useTranslate()
  const isDesktopApp = useWorkspace().host !== null

  if (isDesktopApp) {
    return (
      <NativePreviewSurface
        bytes={bytes}
        mimeType="application/pdf"
        viewport={null}
        reloadKey={reloadKey}
      />
    )
  }

  return (
    <div className={styles.body}>
      <div className={styles.pdfNotice}>
        <span>{t('previewPdfFallbackHint')}</span>
        <button type="button" className={styles.actionChip} onClick={onSave}>
          {t('previewSaveFile')}
        </button>
      </div>
      <iframe key={reloadKey} title={name} src={blobUrl} className={styles.iframeSurface} />
    </div>
  )
}
