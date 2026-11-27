import type { DeliveredFileRef } from '@deepseek-chat/lib-tools'
import { IconBrowseOutline16 } from '@deepseek-chat/lib-ui'
import clsx from 'clsx'
import { activityInspectorMessages } from './messages.js'
import type { ActivityFileItem, ActivityVisualItem } from './timeline.js'
import styles from './ActivityPanel.module.css'

const fileExtensionOf = (name: string): string | null => {
  const dot = name.lastIndexOf('.')
  if (dot <= 0 || dot === name.length - 1) {
    return null
  }
  const ext = name.slice(dot + 1).trim()
  return ext && ext.length <= 6 ? ext.toUpperCase() : null
}

const formatFileSize = (bytes: number): string => {
  if (!Number.isFinite(bytes) || bytes < 0) {
    return ''
  }
  if (bytes < 1024) {
    return `${Math.round(bytes)} B`
  }
  const kb = bytes / 1024
  if (kb < 1024) {
    return `${kb < 10 ? kb.toFixed(1) : Math.round(kb)} KB`
  }
  const mb = kb / 1024
  return `${mb < 10 ? mb.toFixed(1) : Math.round(mb)} MB`
}

const fileGlyphClass = (ext: string | null, mimeType: string): string | undefined => {
  const lower = ext?.toLowerCase() ?? ''
  if (lower === 'pdf' || mimeType === 'application/pdf') {
    return styles.fileGlyphPdf
  }
  if (lower === 'csv' || lower === 'tsv' || lower === 'xls' || lower === 'xlsx') {
    return styles.fileGlyphSheet
  }
  if (lower === 'ppt' || lower === 'pptx' || lower === 'key') {
    return styles.fileGlyphSlide
  }
  if (
    mimeType.startsWith('image/') ||
    mimeType.startsWith('audio/') ||
    mimeType.startsWith('video/') ||
    lower === 'svg' ||
    lower === 'png' ||
    lower === 'jpg' ||
    lower === 'jpeg' ||
    lower === 'webp'
  ) {
    return styles.fileGlyphMedia
  }
  if (
    lower === 'html' ||
    lower === 'htm' ||
    lower === 'md' ||
    lower === 'doc' ||
    lower === 'docx'
  ) {
    return styles.fileGlyphDoc
  }
  return undefined
}

const fileCaptionOf = (file: DeliveredFileRef): string => {
  if (file.title && file.title !== file.name) {
    return file.name
  }
  const size = formatFileSize(file.size)
  if (file.version !== undefined && file.version > 1) {
    return size ? `v${file.version}, ${size}` : `v${file.version}`
  }
  return size || file.name
}

/**
 * Top Outputs strip: surfaces model-generated files (opening File Preview) alongside captured
 * charts and screenshots (opening the Visual Lightbox) in one scannable horizontal strip.
 */
export const EvidenceShelf = ({
  files,
  visuals,
  onOpenFile,
  onOpenVisual,
}: {
  files: readonly ActivityFileItem[]
  visuals: readonly ActivityVisualItem[]
  onOpenFile?: (file: DeliveredFileRef) => void
  onOpenVisual: (index: number) => void
}) => {
  const t = activityInspectorMessages.useTranslate()
  const totalCount = files.length + visuals.length
  if (totalCount === 0) {
    return null
  }

  return (
    <section
      className={styles.evidenceShelf}
      aria-label={t('evidenceOutputsHeading', { count: totalCount })}
    >
      <div className={styles.filmstripSection}>
        <div className={styles.filmstripHeading}>
          {t('evidenceOutputsHeading', { count: totalCount })}
        </div>
        <div className={styles.filmstrip} role="list">
          {files.map((item) => {
            const { file } = item
            const label = file.title || file.name
            const ext = fileExtensionOf(file.name)
            const caption = fileCaptionOf(file)
            const glyphTone = fileGlyphClass(ext, file.mimeType)
            const cardInner = (
              <>
                <span className={styles.fileTileBox}>
                  <span className={styles.fileTileTop}>
                    <span className={clsx(styles.fileTileIcon, glyphTone)} aria-hidden="true">
                      <IconBrowseOutline16 />
                    </span>
                    {ext ? <span className={styles.fileTileExt}>{ext}</span> : null}
                  </span>
                  <span className={styles.fileTileTitle}>{label}</span>
                </span>
                <span className={styles.thumbCaption}>{caption}</span>
              </>
            )
            return (
              <div key={item.key} role="listitem" className={styles.filmstripItem}>
                {onOpenFile ? (
                  <button
                    type="button"
                    className={styles.fileButton}
                    title={
                      file.title && file.title !== file.name
                        ? `${file.title} (${file.name})`
                        : file.name
                    }
                    aria-label={t('inspectFileLabel', { label })}
                    onClick={() => onOpenFile(file)}
                  >
                    {cardInner}
                  </button>
                ) : (
                  <div className={styles.fileStatic} title={file.name}>
                    {cardInner}
                  </div>
                )}
              </div>
            )
          })}

          {visuals.map((visual, index) => {
            const label = visual.caption ?? visual.stepLabel
            return (
              <div key={visual.key} role="listitem" className={styles.filmstripItem}>
                <button
                  type="button"
                  className={styles.thumbButton}
                  title={label}
                  aria-label={t('inspectVisualLabel', { label })}
                  onClick={() => onOpenVisual(index)}
                >
                  <img src={visual.src} alt="" className={styles.thumbImage} />
                  <span className={styles.thumbCaption}>{label}</span>
                </button>
              </div>
            )
          })}
        </div>
      </div>
    </section>
  )
}
