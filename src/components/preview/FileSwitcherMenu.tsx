import clsx from 'clsx'
import { useCallback, useEffect, useState } from 'react'
import { createPortal } from 'react-dom'
import { formatSize, getExtension } from '../../services/attachments.js'
import { acquireBrowserOverlayLock } from '../../services/browser/state.js'
import type { FileVersionEntry } from '../../services/preview/workspace.js'
import { usePresence } from '../../utils/usePresence.js'
import { useAnchoredPosition, useDismiss } from '../base/anchored.js'
import { IconCheckedOutline14, IconChevronDownOutline14 } from '../base/icons.js'
import { FileIcon } from '../files/FileIcon.js'
import styles from './PreviewPanel.module.css'

export type PreviewFileItem = {
  key: string
  title: string
  name: string
  versions: FileVersionEntry[]
  active: FileVersionEntry
}

/** 预览面板顶部文件标识（多文件时支持下拉切换当前对话中的其他文件） */
export const FileSwitcherMenu = ({
  items,
  current,
  onSelect,
}: {
  items: PreviewFileItem[]
  current: PreviewFileItem
  onSelect: (key: string) => void
}) => {
  const [open, setOpen] = useState(false)
  const { mounted, exiting } = usePresence(open, 140)
  const { anchorRef, floatingRef, position } = useAnchoredPosition<
    HTMLButtonElement,
    HTMLDivElement
  >(mounted, { side: 'bottom', align: 'start', offset: 6, measureKey: items.length })

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
  useEffect(() => (mounted ? acquireBrowserOverlayLock() : undefined), [mounted])

  useEffect(() => {
    if (open) {
      floatingRef.current?.focus({ preventScroll: true })
    }
  }, [open, floatingRef])

  const ext = getExtension(current.name)
  const canSwitch = items.length > 1

  if (!canSwitch) {
    return (
      <div className={styles.headerTitleStatic} title={current.name}>
        <span className={styles.headerFileIcon}>
          <FileIcon ext={ext} />
        </span>
        <span className={styles.headerTitleText}>{current.title}</span>
      </div>
    )
  }

  return (
    <>
      <button
        ref={anchorRef}
        type="button"
        className={clsx(styles.headerTitleBtn, open && styles.headerTitleBtnOpen)}
        title={current.name}
        aria-haspopup="menu"
        aria-expanded={open}
        onClick={() => setOpen((value) => !value)}
      >
        <span className={styles.headerFileIcon}>
          <FileIcon ext={ext} />
        </span>
        <span className={styles.headerTitleText}>{current.title}</span>
        <span className={styles.headerTitleChevron}>
          <IconChevronDownOutline14 />
        </span>
      </button>
      {mounted
        ? createPortal(
            <div
              ref={floatingRef}
              tabIndex={-1}
              role="menu"
              className={clsx(styles.fileMenu, exiting && styles.versionMenuExiting)}
              style={position ?? { top: 0, left: 0, visibility: 'hidden' }}
              onKeyDown={(event) => {
                if (event.key === 'Escape') {
                  event.preventDefault()
                  event.stopPropagation()
                  close(true)
                }
              }}
            >
              {items.map((item) => {
                const selected = item.key === current.key
                const itemExt = getExtension(item.name)
                return (
                  <button
                    key={item.key}
                    type="button"
                    role="menuitemradio"
                    aria-checked={selected}
                    className={clsx(styles.versionOption, selected && styles.versionOptionSelected)}
                    onClick={() => {
                      close(false)
                      onSelect(item.key)
                    }}
                  >
                    <span className={styles.versionOptionCheck} aria-hidden>
                      {selected ? <IconCheckedOutline14 /> : null}
                    </span>
                    <span className={styles.headerFileIcon}>
                      <FileIcon ext={itemExt} />
                    </span>
                    <span className={styles.fileOptionLabel}>{item.title}</span>
                    <span className={styles.versionOptionMeta}>{formatSize(item.active.size)}</span>
                  </button>
                )
              })}
            </div>,
            document.body
          )
        : null}
    </>
  )
}
