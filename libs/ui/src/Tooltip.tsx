import clsx from 'clsx'
import { useEffect, type ReactNode } from 'react'
import { createPortal } from 'react-dom'
import { useAnchoredPosition, useDelayedOpen } from './anchored.js'
import { useIsMobile } from './runtime.js'
import styles from './Tooltip.module.css'

export type TooltipPlacement = 'top' | 'bottom'

const ENTER_DELAY_MS = 100
const LEAVE_DELAY_MS = 80

export type TooltipProps = {
  content: ReactNode
  placement?: TooltipPlacement
  disabled?: boolean
  children?: ReactNode
}

/**
 * Accessible tooltip (WCAG 1.4.13): opens on hover (100ms delay) and focus, stays visible
 * while the pointer hovers the tooltip itself, dismisses on Escape without moving the pointer,
 * and stays suppressed on mobile viewports.
 */
export const Tooltip = ({
  content,
  placement = 'top',
  disabled = false,
  children,
}: TooltipProps) => {
  const isMobile = useIsMobile()
  const { open, setOpen, schedule, cancel } = useDelayedOpen()
  const { anchorRef, floatingRef, position } = useAnchoredPosition<HTMLSpanElement, HTMLDivElement>(
    open && !disabled,
    { side: placement, align: 'center', measureFirstChild: true, measureKey: content }
  )

  useEffect(() => () => cancel(), [cancel])

  useEffect(() => {
    if (disabled) {
      cancel()
      setOpen(false)
    }
  }, [cancel, disabled, setOpen])

  useEffect(() => {
    if (!open) {
      return
    }
    const onScroll = () => setOpen(false)
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        cancel()
        setOpen(false)
      }
    }
    window.addEventListener('scroll', onScroll, true)
    document.addEventListener('keydown', onKeyDown)
    return () => {
      window.removeEventListener('scroll', onScroll, true)
      document.removeEventListener('keydown', onKeyDown)
    }
  }, [cancel, open, setOpen])

  const visible =
    open && !disabled && !isMobile && Boolean(content) && typeof document !== 'undefined'
  const portalTarget = visible
    ? ((anchorRef.current?.firstElementChild as HTMLElement | null)?.closest('dialog') ??
      anchorRef.current?.closest('dialog') ??
      document.body)
    : null

  return (
    <>
      <span
        ref={anchorRef}
        className={styles.trigger}
        onMouseEnter={() => {
          if (!disabled) {
            schedule(true, ENTER_DELAY_MS)
          }
        }}
        onMouseLeave={() => schedule(false, LEAVE_DELAY_MS)}
        onFocusCapture={() => {
          if (!disabled) {
            schedule(true, 0)
          }
        }}
        onBlurCapture={() => schedule(false, 0)}
      >
        {children}
      </span>
      {visible && portalTarget
        ? createPortal(
            <div
              ref={floatingRef}
              role="tooltip"
              data-ui-floating=""
              className={clsx(
                styles.tooltip,
                (position?.resolvedSide ?? placement) === 'top' ? styles.top : styles.bottom
              )}
              style={
                position
                  ? { top: position.top, left: position.left, right: position.right }
                  : { top: 0, left: 0, visibility: 'hidden' }
              }
              onMouseEnter={cancel}
              onMouseLeave={() => schedule(false, LEAVE_DELAY_MS)}
            >
              {content}
            </div>,
            portalTarget
          )
        : null}
    </>
  )
}
