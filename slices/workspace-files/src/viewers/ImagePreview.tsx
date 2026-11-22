import { useState } from 'react'
import { workspaceMessages } from '../messages.js'
import { formatSize } from '../format.js'
import styles from '../PreviewPanel.module.css'

/** 位图与 SVG 安全预览：统一经 <img> 渲染，避免在主应用 DOM 中执行未消毒的 SVG 脚本 */
export const ImagePreview = ({
  blobUrl,
  name,
  size,
  actualSize,
  onToggleActualSize,
}: {
  blobUrl: string
  name: string
  size: number
  actualSize: boolean
  onToggleActualSize: () => void
}) => {
  const t = workspaceMessages.useTranslate()
  const [dimensions, setDimensions] = useState<{ width: number; height: number } | null>(null)

  return (
    <div className={styles.imageStage}>
      <div className={styles.imageScroll}>
        <img
          src={blobUrl}
          alt={name}
          className={actualSize ? styles.imageActual : styles.imageFit}
          onLoad={(event) => {
            const img = event.currentTarget
            if (img.naturalWidth > 0 && img.naturalHeight > 0) {
              setDimensions({ width: img.naturalWidth, height: img.naturalHeight })
            }
          }}
        />
      </div>
      <div className={styles.imageFooter}>
        <span>
          {dimensions ? `${dimensions.width} × ${dimensions.height} · ` : ''}
          {formatSize(size)}
        </span>
        <button type="button" className={styles.actionChip} onClick={onToggleActualSize}>
          {t(actualSize ? 'previewZoomFit' : 'previewZoomActual')}
        </button>
      </div>
    </div>
  )
}
