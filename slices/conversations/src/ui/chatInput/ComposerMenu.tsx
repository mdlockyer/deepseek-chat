import {
  IconPanelContractOutline14,
  IconPaperclipOutline16,
  IconPlusOutline14,
  MorphMenu,
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

export type MenuRowDirection = 1 | -1 | 'first' | 'last'

/** Moves focus between a menu's enabled `data-composer-row` buttons (wrapping at the ends). */
export const focusMenuRow = (container: HTMLElement | null, direction: MenuRowDirection) => {
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

/** Arrow / Home / End navigation for a menu surface; returns true when it handled the key. */
export const handleMenuRowKey = (container: HTMLElement | null, key: string): boolean => {
  const direction: MenuRowDirection | null =
    key === 'ArrowDown'
      ? 1
      : key === 'ArrowUp'
        ? -1
        : key === 'Home'
          ? 'first'
          : key === 'End'
            ? 'last'
            : null
  if (direction === null) {
    return false
  }
  focusMenuRow(container, direction)
  return true
}

/** `+` under the composer: add files, and compact the conversation when it has history. */
export const ComposerMenu = ({
  disabled = false,
  canCompact = false,
  onUploadFiles,
  onCompact,
}: {
  disabled?: boolean
  canCompact?: boolean
  onUploadFiles: () => void
  onCompact?: () => void
}) => {
  const t = useTranslate()
  const [open, setOpen] = useState(false)
  const anchorRef = useRef<HTMLButtonElement>(null)
  const listRef = useRef<HTMLDivElement>(null)
  const focusLastOnOpenRef = useRef(false)

  const focusRow = useCallback(
    (direction: MenuRowDirection) => focusMenuRow(listRef.current, direction),
    []
  )

  useEffect(() => {
    if (!open || !focusLastOnOpenRef.current) {
      return
    }
    focusLastOnOpenRef.current = false
    const frame = requestAnimationFrame(() => focusRow('last'))
    return () => cancelAnimationFrame(frame)
  }, [open, focusRow])

  const tooltipText = t('composerMenuTooltip')

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
        </button>
      </Tooltip>
      <MorphMenu
        open={open}
        onOpenChange={setOpen}
        anchorRef={anchorRef}
        side="top"
        align="start"
        measureKey={onCompact ? 'compact' : 'files'}
        autoFocusSurface
        role="dialog"
        ariaLabel={t('composerMenuTooltip')}
        className={styles.menu}
        contentRef={listRef}
        onKeyDown={(event) => {
          if (isUploadShortcut(event.nativeEvent)) {
            event.preventDefault()
            setOpen(false)
            onUploadFiles()
            return
          }
          if (handleMenuRowKey(listRef.current, event.key)) {
            event.preventDefault()
          }
        }}
      >
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
        {onCompact ? (
          <button
            type="button"
            data-composer-row=""
            className={styles.row}
            disabled={disabled || !canCompact}
            onClick={() => {
              setOpen(false)
              onCompact()
            }}
          >
            <span className={styles.rowIcon}>
              <IconPanelContractOutline14 />
            </span>
            <span className={styles.rowLabel}>{t('compactConversation')}</span>
          </button>
        ) : null}
      </MorphMenu>
    </>
  )
}
