import clsx from 'clsx'
import {
  useCallback,
  useEffect,
  type KeyboardEventHandler,
  type ReactNode,
  type RefObject,
} from 'react'
import { createPortal } from 'react-dom'
import { useAnchoredPosition, useDismiss, type Align, type Side } from './anchored.js'
import { usePresence } from './runtime.js'
import { useOverlayLock } from './UiProvider.js'
import styles from './Popover.module.css'

const EXIT_DURATION_MS = 140

export type PopoverProps = {
  open: boolean
  onOpenChange: (open: boolean) => void
  anchorRef: RefObject<HTMLElement | null>
  side?: Side
  align?: Align
  alignOffset?: number
  offset?: number
  maxHeight?: number
  minSpace?: number
  measureKey?: unknown
  /** Captures Escape before parent overlays (e.g. Select inside a Dialog). */
  captureEscape?: boolean
  /** Automatically focuses the floating container when opened. */
  autoFocusSurface?: boolean
  /** Acquires an OverlayPort lock while mounted (default true). */
  lockOverlay?: boolean
  /** How long the surface stays mounted after closing, for a custom exit animation (default 140ms). */
  exitDurationMs?: number
  role?: 'dialog' | 'menu' | 'listbox'
  ariaLabel?: string
  className?: string
  onKeyDown?: KeyboardEventHandler<HTMLDivElement>
  children: ReactNode
}

/**
 * Shared anchored floating surface powering Menu, Select, ComposerMenu, ViewportMenu,
 * and custom popovers. Coordinates viewport clamping, Escape/outside dismiss, focus return,
 * and OverlayPort locking for native desktop webviews.
 */
export const Popover = ({
  open,
  onOpenChange,
  anchorRef,
  side = 'bottom',
  align = 'start',
  alignOffset = 0,
  offset = 6,
  maxHeight,
  minSpace,
  measureKey,
  captureEscape = false,
  autoFocusSurface = false,
  lockOverlay = true,
  exitDurationMs = EXIT_DURATION_MS,
  role = 'dialog',
  ariaLabel,
  className,
  onKeyDown,
  children,
}: PopoverProps) => {
  const { mounted, exiting } = usePresence(open, exitDurationMs)
  const {
    anchorRef: internalAnchorRef,
    floatingRef,
    position,
  } = useAnchoredPosition<HTMLElement, HTMLDivElement>(mounted, {
    side,
    align,
    alignOffset,
    offset,
    maxHeight,
    minSpace,
    measureKey,
  })

  internalAnchorRef.current = anchorRef.current

  const dismiss = useCallback(
    (restoreFocus: boolean) => {
      onOpenChange(false)
      if (restoreFocus) {
        requestAnimationFrame(() => anchorRef.current?.focus({ preventScroll: true }))
      }
    },
    [anchorRef, onOpenChange]
  )

  useDismiss(open, [anchorRef, floatingRef], dismiss, { captureEscape })
  useOverlayLock(lockOverlay && mounted)

  useEffect(() => {
    if (open && autoFocusSurface) {
      floatingRef.current?.focus({ preventScroll: true })
    }
  }, [open, autoFocusSurface, floatingRef])

  if (!mounted || typeof document === 'undefined') {
    return null
  }

  const portalTarget = anchorRef.current?.closest('dialog') ?? document.body

  return createPortal(
    <div
      ref={floatingRef}
      tabIndex={autoFocusSurface ? -1 : undefined}
      role={role}
      aria-label={ariaLabel}
      data-ui-floating=""
      data-side={position?.resolvedSide ?? side}
      data-align={align}
      data-state={exiting ? 'closed' : 'open'}
      className={clsx(styles.surface, exiting && styles.exiting, className)}
      style={
        position
          ? {
              top: position.top,
              left: position.left,
              right: position.right,
              maxHeight: position.maxHeight,
            }
          : { top: 0, left: 0, visibility: 'hidden' }
      }
      onKeyDown={onKeyDown}
    >
      {children}
    </div>,
    portalTarget
  )
}
