import {
  Button,
  Dialog,
  IconButton,
  IconChevronLeftOutline14,
  IconChevronRightOutline14,
  IconOpenExternalOutline14,
} from '@deepseek-chat/lib-ui'
import { useEffect, type MouseEvent } from 'react'
import { activityInspectorMessages } from './messages.js'
import type { ActivityVisualItem } from './timeline.js'
import styles from './ActivityPanel.module.css'

const hostLabelOf = (href: string): string | null => {
  try {
    return new URL(href).hostname.replace(/^www\./, '') || null
  } catch {
    return null
  }
}

/** Native modal lightbox for inspecting Activity screenshots and generated figures at full size. */
export const VisualLightbox = ({
  visuals,
  activeIndex,
  onChangeIndex,
  onClose,
  onInspectStep,
  onOpenLink,
}: {
  visuals: readonly ActivityVisualItem[]
  activeIndex: number | null
  onChangeIndex: (index: number) => void
  onClose: () => void
  onInspectStep: (callId: string) => void
  onOpenLink: (event: MouseEvent, url: string) => void
}) => {
  const t = activityInspectorMessages.useTranslate()
  const open = activeIndex !== null && activeIndex >= 0 && activeIndex < visuals.length
  const current = open ? visuals[activeIndex] : null
  const total = visuals.length

  useEffect(() => {
    if (!open || total <= 1 || activeIndex === null) {
      return
    }
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'ArrowLeft') {
        event.preventDefault()
        onChangeIndex((activeIndex - 1 + total) % total)
      } else if (event.key === 'ArrowRight') {
        event.preventDefault()
        onChangeIndex((activeIndex + 1) % total)
      }
    }
    document.addEventListener('keydown', onKeyDown)
    return () => document.removeEventListener('keydown', onKeyDown)
  }, [activeIndex, onChangeIndex, open, total])

  const href = current?.href && /^https?:\/\//i.test(current.href) ? current.href : null
  const host = href ? hostLabelOf(href) : null

  return (
    <Dialog
      open={open}
      size="lg"
      closable
      title={current ? (current.caption ?? current.stepLabel) : ''}
      className={styles.lightboxDialog}
      mainClassName={styles.lightboxMain}
      onClose={onClose}
      footer={
        current ? (
          <div className={styles.lightboxFooter}>
            <div className={styles.lightboxNav}>
              {total > 1 && activeIndex !== null ? (
                <>
                  <IconButton
                    size="sm"
                    icon={<IconChevronLeftOutline14 />}
                    tooltip={t('lightboxPrev')}
                    aria-label={t('lightboxPrev')}
                    onClick={() => onChangeIndex((activeIndex - 1 + total) % total)}
                  />
                  <span className={styles.lightboxCounter}>
                    {t('lightboxCounter', { current: activeIndex + 1, total })}
                  </span>
                  <IconButton
                    size="sm"
                    icon={<IconChevronRightOutline14 />}
                    tooltip={t('lightboxNext')}
                    aria-label={t('lightboxNext')}
                    onClick={() => onChangeIndex((activeIndex + 1) % total)}
                  />
                </>
              ) : null}
            </div>
            <div className={styles.lightboxActions}>
              {href ? (
                <a
                  className={styles.lightboxLink}
                  href={href}
                  target="_blank"
                  rel="noreferrer"
                  onClick={(event) => onOpenLink(event, href)}
                >
                  <span>{host ? t('lightboxOpenHost', { host }) : t('lightboxOpenPage')}</span>
                  <IconOpenExternalOutline14 />
                </a>
              ) : null}
              {current.callId ? (
                <Button
                  variant="secondary"
                  size="s"
                  onClick={() => {
                    onClose()
                    onInspectStep(current.callId)
                  }}
                >
                  {t('lightboxShowStep')}
                </Button>
              ) : null}
            </div>
          </div>
        ) : undefined
      }
    >
      {current ? (
        <div className={styles.lightboxStage}>
          <img src={current.src} alt={current.alt} className={styles.lightboxImage} />
        </div>
      ) : null}
    </Dialog>
  )
}
