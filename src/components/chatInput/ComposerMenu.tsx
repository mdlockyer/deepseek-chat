import clsx from 'clsx'
import { useCallback, useEffect, useState, type ReactNode } from 'react'
import { createPortal } from 'react-dom'
import { useTranslate } from '../../i18n/index.js'
import { acquireOverlay } from '@deepseek-chat/spine/design'
import { usePresence } from '@deepseek-chat/spine/design'
import { useAnchoredPosition, useDismiss } from '@deepseek-chat/spine/design'
import { IconPaperclipOutline16, IconPlusOutline14 } from '@deepseek-chat/spine/design'
import { Tooltip } from '@deepseek-chat/spine/design'
import styles from './ComposerMenu.module.css'

export type ComposerToolSwitch = {
  key: string
  label: string
  icon: ReactNode
  checked: boolean
  onToggle: () => void
}

const isMacPlatform =
  typeof navigator !== 'undefined' &&
  /Mac|iPhone|iPad/i.test(navigator.platform || navigator.userAgent)

export const isUploadShortcut = (
  event: Pick<KeyboardEvent, 'metaKey' | 'ctrlKey' | 'altKey' | 'shiftKey' | 'key'>
) =>
  (isMacPlatform ? event.metaKey && !event.ctrlKey : event.ctrlKey && !event.metaKey) &&
  !event.altKey &&
  !event.shiftKey &&
  event.key.toLowerCase() === 'u'

/** 输入框左下角 `+` 菜单：整合上传文件与推理/工具开关，减少底部常驻胶囊噪音 */
export const ComposerMenu = ({
  tools,
  disabled = false,
  onUploadFiles,
}: {
  tools: ComposerToolSwitch[]
  disabled?: boolean
  onUploadFiles: () => void
}) => {
  const t = useTranslate()
  const [open, setOpen] = useState(false)
  const { mounted, exiting } = usePresence(open, 140)
  const { anchorRef, floatingRef, position } = useAnchoredPosition<
    HTMLButtonElement,
    HTMLDivElement
  >(mounted, { side: 'top', align: 'start', offset: 8, measureKey: tools.length })

  const close = useCallback(
    (restoreFocus = false) => {
      setOpen(false)
      if (restoreFocus) {
        requestAnimationFrame(() => anchorRef.current?.focus({ preventScroll: true }))
      }
    },
    [anchorRef]
  )

  useDismiss(open, [anchorRef, floatingRef], () => close(false))
  useEffect(() => (mounted ? acquireOverlay() : undefined), [mounted])

  // 打开时按键盘交互习惯聚焦浮层容器（或首项），支持上下键遍历选项
  useEffect(() => {
    if (open) {
      floatingRef.current?.focus({ preventScroll: true })
    }
  }, [open, floatingRef])

  const activeLabels = tools.filter((item) => item.checked).map((item) => item.label)
  const tooltipText =
    activeLabels.length > 0
      ? t('composerMenuActiveTooltip', { tools: activeLabels.join(', ') })
      : t('composerMenuTooltip')

  const focusRow = (direction: 1 | -1 | 'first' | 'last') => {
    const container = floatingRef.current
    if (!container) {
      return
    }
    const rows = Array.from(
      container.querySelectorAll<HTMLButtonElement>('button[data-composer-row]:not(:disabled)')
    )
    if (rows.length === 0) {
      return
    }
    if (direction === 'first') {
      rows[0]?.focus({ preventScroll: true })
      return
    }
    if (direction === 'last') {
      rows.at(-1)?.focus({ preventScroll: true })
      return
    }
    const activeIndex = rows.indexOf(document.activeElement as HTMLButtonElement)
    const nextIndex =
      activeIndex === -1
        ? direction === 1
          ? 0
          : rows.length - 1
        : (activeIndex + direction + rows.length) % rows.length
    rows[nextIndex]?.focus({ preventScroll: true })
  }

  return (
    <>
      <Tooltip content={tooltipText} disabled={open}>
        <button
          ref={anchorRef}
          type="button"
          className={clsx(styles.trigger, open && styles.triggerOpen)}
          aria-label={tooltipText}
          aria-haspopup="dialog"
          aria-expanded={open}
          disabled={disabled}
          onClick={() => setOpen((value) => !value)}
          onKeyDown={(event) => {
            if (event.key === 'Escape' && open) {
              event.preventDefault()
              event.stopPropagation()
              close(true)
              return
            }
            if (event.key === 'ArrowUp' && !open) {
              event.preventDefault()
              setOpen(true)
              requestAnimationFrame(() => focusRow('last'))
            }
          }}
        >
          <span className={styles.plusIcon}>
            <IconPlusOutline14 />
          </span>
          {activeLabels.length > 0 ? <span className={styles.activeDot} aria-hidden /> : null}
        </button>
      </Tooltip>
      {mounted
        ? createPortal(
            <div
              ref={floatingRef}
              tabIndex={-1}
              role="dialog"
              aria-label={t('composerMenuTooltip')}
              className={clsx(styles.menu, exiting && styles.exiting)}
              style={position ?? { top: 0, left: 0, visibility: 'hidden' }}
              onKeyDown={(event) => {
                if (event.key === 'Escape') {
                  event.preventDefault()
                  event.stopPropagation()
                  close(true)
                  return
                }
                if (isUploadShortcut(event.nativeEvent)) {
                  event.preventDefault()
                  close(false)
                  onUploadFiles()
                  return
                }
                if (event.key === 'ArrowDown') {
                  event.preventDefault()
                  focusRow(1)
                } else if (event.key === 'ArrowUp') {
                  event.preventDefault()
                  focusRow(-1)
                } else if (event.key === 'Home') {
                  event.preventDefault()
                  focusRow('first')
                } else if (event.key === 'End') {
                  event.preventDefault()
                  focusRow('last')
                }
              }}
            >
              <button
                type="button"
                data-composer-row=""
                className={styles.row}
                disabled={disabled}
                onClick={() => {
                  close(false)
                  onUploadFiles()
                }}
              >
                <span className={styles.rowIcon}>
                  <IconPaperclipOutline16 />
                </span>
                <span className={styles.rowLabel}>{t('uploadFile')}</span>
                <kbd className={styles.shortcut}>{isMacPlatform ? '⌘U' : 'Ctrl+U'}</kbd>
              </button>
              <div className={styles.divider} role="separator" />
              {tools.map((tool) => (
                <button
                  key={tool.key}
                  type="button"
                  role="switch"
                  aria-checked={tool.checked}
                  data-composer-row=""
                  className={styles.row}
                  onClick={tool.onToggle}
                >
                  <span className={clsx(styles.rowIcon, tool.checked && styles.rowIconActive)}>
                    {tool.icon}
                  </span>
                  <span className={styles.rowLabel}>{tool.label}</span>
                  <span
                    className={clsx(styles.switchTrack, tool.checked && styles.switchTrackOn)}
                    aria-hidden
                  >
                    <span className={styles.switchThumb} />
                  </span>
                </button>
              ))}
            </div>,
            document.body
          )
        : null}
    </>
  )
}
