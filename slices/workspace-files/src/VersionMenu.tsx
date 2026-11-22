import clsx from 'clsx'
import { useCallback, useEffect, useState } from 'react'
import { createPortal } from 'react-dom'
import { workspaceMessages } from './messages.js'
import { formatSize } from './format.js'
import { acquireOverlay } from '@deepseek-chat/spine/design'
import type { FileVersionEntry } from './workspace.js'
import { usePresence } from '@deepseek-chat/spine/design'
import { useAnchoredPosition, useDismiss } from '@deepseek-chat/spine/design'
import { IconCheckedOutline14, IconChevronDownOutline14 } from '@deepseek-chat/spine/design'
import styles from './PreviewPanel.module.css'

/** 文件历史版本下拉选择器 */
export const VersionMenu = ({
  versions,
  selectedFileId,
  onSelect,
}: {
  versions: FileVersionEntry[]
  selectedFileId: string
  onSelect: (fileId: string | null) => void
}) => {
  const t = workspaceMessages.useTranslate()
  const [open, setOpen] = useState(false)
  const { mounted, exiting } = usePresence(open, 140)
  const latest = versions.at(-1)
  const current = versions.find((v) => v.fileId === selectedFileId) ?? latest
  const { anchorRef, floatingRef, position } = useAnchoredPosition<
    HTMLButtonElement,
    HTMLDivElement
  >(mounted, { side: 'bottom', align: 'start', offset: 6, measureKey: versions.length })

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

  useEffect(() => {
    if (open) {
      floatingRef.current?.focus({ preventScroll: true })
    }
  }, [open, floatingRef])

  if (!current || versions.length <= 1) {
    return null
  }

  return (
    <>
      <button
        ref={anchorRef}
        type="button"
        className={clsx(styles.actionChip, open && styles.actionChipActive)}
        aria-haspopup="menu"
        aria-expanded={open}
        onClick={() => setOpen((value) => !value)}
      >
        <span>{t('previewVersionLabel', { version: current.version })}</span>
        <IconChevronDownOutline14 />
      </button>
      {mounted
        ? createPortal(
            <div
              ref={floatingRef}
              tabIndex={-1}
              role="menu"
              className={clsx(styles.versionMenu, exiting && styles.versionMenuExiting)}
              style={position ?? { top: 0, left: 0, visibility: 'hidden' }}
              onKeyDown={(event) => {
                if (event.key === 'Escape') {
                  event.preventDefault()
                  event.stopPropagation()
                  close(true)
                }
              }}
            >
              {[...versions].reverse().map((item) => {
                const selected = item.fileId === current.fileId
                const isLatest = item.fileId === latest?.fileId
                return (
                  <button
                    key={item.fileId}
                    type="button"
                    role="menuitemradio"
                    aria-checked={selected}
                    className={clsx(styles.versionOption, selected && styles.versionOptionSelected)}
                    onClick={() => {
                      close(false)
                      onSelect(isLatest ? null : item.fileId)
                    }}
                  >
                    <span className={styles.versionOptionCheck} aria-hidden>
                      {selected ? <IconCheckedOutline14 /> : null}
                    </span>
                    <span>
                      {t('previewVersionLabel', { version: item.version })}
                      {isLatest ? ` · ${t('previewVersionLatest')}` : ''}
                    </span>
                    <span className={styles.versionOptionMeta}>{formatSize(item.size)}</span>
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
