import clsx from 'clsx'
import { useEffect, type HTMLAttributes, type MutableRefObject, type ReactNode } from 'react'
import { createPortal } from 'react-dom'
import { useAnchoredPosition, useDelayedOpen, type Align, type Side } from './anchored.js'
import styles from './HoverCard.module.css'

const ENTER_DELAY_MS = 300
const LEAVE_DELAY_MS = 100
const DEFAULT_OFFSET = 6

export type HoverCardTrigger = (props: {
  domRef: MutableRefObject<HTMLSpanElement | null>
  domProps: Omit<HTMLAttributes<HTMLSpanElement>, 'children' | 'className' | 'style'> | undefined
}) => ReactNode

export type HoverCardProps = {
  renderTrigger: HoverCardTrigger
  side?: Side
  align?: Align
  offset?: number
  className?: string
  children: ReactNode
}

/**
 * Interactive hover/focus preview card (WCAG 1.4.13 compliant): opens after 300ms hover
 * or keyboard focus, remains interactive when the pointer enters the card, and dismisses on Escape.
 */
export const HoverCard = ({
  renderTrigger,
  side = 'bottom',
  align = 'center',
  offset = DEFAULT_OFFSET,
  className,
  children,
}: HoverCardProps) => {
  const { open, setOpen, schedule, cancel } = useDelayedOpen()
  const { anchorRef, floatingRef, position } = useAnchoredPosition<HTMLSpanElement, HTMLDivElement>(
    open,
    { side, align, offset }
  )

  useEffect(() => () => cancel(), [cancel])

  useEffect(() => {
    if (!open) {
      return
    }
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        cancel()
        setOpen(false)
      }
    }
    document.addEventListener('keydown', onKeyDown)
    return () => document.removeEventListener('keydown', onKeyDown)
  }, [cancel, open, setOpen])

  const portalTarget =
    open && typeof document !== 'undefined'
      ? (anchorRef.current?.closest('dialog') ?? document.body)
      : null

  return (
    <>
      {renderTrigger({
        domRef: anchorRef,
        domProps: {
          onMouseEnter: () => schedule(true, ENTER_DELAY_MS),
          onMouseLeave: () => schedule(false, LEAVE_DELAY_MS),
          onFocus: () => schedule(true, 0),
          onBlur: () => schedule(false, LEAVE_DELAY_MS),
        },
      })}
      {open && portalTarget
        ? createPortal(
            <div
              ref={floatingRef}
              data-ui-floating=""
              className={clsx(styles.card, className)}
              style={
                position
                  ? { top: position.top, left: position.left, right: position.right }
                  : { top: 0, left: 0, visibility: 'hidden' }
              }
              onMouseEnter={cancel}
              onMouseLeave={() => schedule(false, LEAVE_DELAY_MS)}
            >
              {children}
            </div>,
            portalTarget
          )
        : null}
    </>
  )
}
