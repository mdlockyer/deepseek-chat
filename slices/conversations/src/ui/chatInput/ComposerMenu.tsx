import {
  IconPaperclipOutline16,
  IconPlusOutline14,
  Popover,
  Switch,
  Tooltip,
} from '@deepseek-chat/lib-ui'
import clsx from 'clsx'
import { useCallback, useEffect, useRef, useState, type ReactNode } from 'react'
import { useTranslate } from '../../messages.js'
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
  const anchorRef = useRef<HTMLButtonElement>(null)
  const listRef = useRef<HTMLDivElement>(null)
  const focusLastOnOpenRef = useRef(false)

  const focusRow = useCallback((direction: 1 | -1 | 'first' | 'last') => {
    const container = listRef.current
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
  }, [])

  useEffect(() => {
    if (!open || !focusLastOnOpenRef.current) {
      return
    }
    focusLastOnOpenRef.current = false
    const frame = requestAnimationFrame(() => focusRow('last'))
    return () => cancelAnimationFrame(frame)
  }, [open, focusRow])

  const activeLabels = tools.filter((item) => item.checked).map((item) => item.label)
  const tooltipText =
    activeLabels.length > 0
      ? t('composerMenuActiveTooltip', { tools: activeLabels.join(', ') })
      : t('composerMenuTooltip')

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
            if (event.key === 'ArrowUp' && !open) {
              event.preventDefault()
              focusLastOnOpenRef.current = true
              setOpen(true)
            }
          }}
        >
          <span className={styles.plusIcon}>
            <IconPlusOutline14 />
          </span>
          {activeLabels.length > 0 ? <span className={styles.activeDot} aria-hidden /> : null}
        </button>
      </Tooltip>
      <Popover
        open={open}
        onOpenChange={setOpen}
        anchorRef={anchorRef}
        side="top"
        align="start"
        offset={8}
        measureKey={tools.length}
        autoFocusSurface
        role="dialog"
        ariaLabel={t('composerMenuTooltip')}
        className={styles.menu}
        onKeyDown={(event) => {
          if (isUploadShortcut(event.nativeEvent)) {
            event.preventDefault()
            setOpen(false)
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
        <div ref={listRef}>
          <button
            type="button"
            data-composer-row=""
            className={styles.row}
            disabled={disabled}
            onClick={() => {
              setOpen(false)
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
            <Switch
              key={tool.key}
              block
              data-composer-row=""
              icon={tool.icon}
              label={tool.label}
              checked={tool.checked}
              onChange={tool.onToggle}
            />
          ))}
        </div>
      </Popover>
    </>
  )
}
