import clsx from 'clsx'
import {
  useCallback,
  useEffect,
  useRef,
  useState,
  type KeyboardEvent,
  type KeyboardEventHandler,
  type ReactNode,
} from 'react'
import type { Align, Side } from './anchored.js'
import { IconCheckOutline16 } from './icons.js'
import { Popover } from './Popover.js'
import styles from './Menu.module.css'

export type MenuCommandOption = {
  type?: 'command'
  key: string
  label: string
  icon?: ReactNode
  shortcut?: string
  danger?: boolean
  disabled?: boolean
  onSelect: () => void
}

export type MenuRadioOption = {
  type: 'radio'
  key: string
  label: string
  icon?: ReactNode
  checked: boolean
  disabled?: boolean
  onSelect: () => void
}

export type MenuSwitchOption = {
  type: 'switch'
  key: string
  label: string
  icon?: ReactNode
  checked: boolean
  disabled?: boolean
  keepOpen?: boolean
  onSelect: () => void
}

export type MenuSeparatorOption = {
  type: 'separator'
  key: string
}

export type MenuOption =
  | MenuCommandOption
  | MenuRadioOption
  | MenuSwitchOption
  | MenuSeparatorOption

export type MenuTriggerProps = {
  'aria-haspopup': 'menu'
  'aria-expanded': boolean
  onClick: () => void
  onKeyDown: KeyboardEventHandler<HTMLElement>
}

export type MenuRenderProps = {
  open: boolean
  toggle: () => void
  close: () => void
  triggerProps: MenuTriggerProps
}

export type MenuProps = {
  options: MenuOption[]
  side?: Side
  align?: Align
  alignOffset?: number
  offset?: number
  maxHeight?: number
  ariaLabel?: string
  className?: string
  renderTrigger?: (props: MenuRenderProps) => ReactNode
  children?: (props: MenuRenderProps) => ReactNode
}

const getEnabledButtons = (root: HTMLElement | null): HTMLButtonElement[] =>
  root
    ? Array.from(
        root.querySelectorAll<HTMLButtonElement>('button[role^="menuitem"]:not(:disabled)')
      )
    : []

/**
 * Accessible dropdown menu built on Popover: renders native `<button>` items (`menuitem`,
 * `menuitemradio`, `menuitemcheckbox`), `<hr>` separators, Arrow/Home/End/Escape navigation,
 * and automatic OverlayPort locking.
 */
export const Menu = ({
  options,
  side = 'bottom',
  align = 'start',
  alignOffset = -5,
  offset = 4,
  maxHeight,
  ariaLabel,
  className,
  renderTrigger,
  children,
}: MenuProps) => {
  const [open, setOpen] = useState(false)
  const anchorRef = useRef<HTMLSpanElement>(null)
  const listRef = useRef<HTMLDivElement>(null)
  const focusEdgeRef = useRef<'first' | 'last'>('first')

  const focusTrigger = useCallback(() => {
    const trigger = anchorRef.current?.querySelector<HTMLElement>(
      'button, [href], [tabindex]:not([tabindex="-1"])'
    )
    requestAnimationFrame(() => trigger?.focus({ preventScroll: true }))
  }, [])

  const close = useCallback(
    (restoreFocus = false) => {
      setOpen(false)
      if (restoreFocus) {
        focusTrigger()
      }
    },
    [focusTrigger]
  )

  const toggle = useCallback(() => {
    focusEdgeRef.current = 'first'
    setOpen((value) => !value)
  }, [])

  useEffect(() => {
    if (!open) {
      return
    }
    const frame = requestAnimationFrame(() => {
      const items = getEnabledButtons(listRef.current)
      const target = focusEdgeRef.current === 'last' ? items.at(-1) : items[0]
      target?.focus({ preventScroll: true })
    })
    return () => cancelAnimationFrame(frame)
  }, [open])

  const onTriggerKeyDown = useCallback((event: KeyboardEvent<HTMLElement>) => {
    if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
      event.preventDefault()
      focusEdgeRef.current = event.key === 'ArrowUp' ? 'last' : 'first'
      setOpen(true)
    }
  }, [])

  const onMenuKeyDown = useCallback((event: KeyboardEvent<HTMLDivElement>) => {
    const items = getEnabledButtons(listRef.current)
    if (items.length === 0) {
      return
    }
    const currentIndex = items.indexOf(document.activeElement as HTMLButtonElement)
    if (event.key === 'ArrowDown') {
      event.preventDefault()
      items[(currentIndex + 1) % items.length]?.focus({ preventScroll: true })
    } else if (event.key === 'ArrowUp') {
      event.preventDefault()
      items[(currentIndex - 1 + items.length) % items.length]?.focus({ preventScroll: true })
    } else if (event.key === 'Home') {
      event.preventDefault()
      items[0]?.focus({ preventScroll: true })
    } else if (event.key === 'End') {
      event.preventDefault()
      items.at(-1)?.focus({ preventScroll: true })
    } else if (event.key === 'Tab') {
      setOpen(false)
    }
  }, [])

  const triggerRenderer = renderTrigger ?? children

  return (
    <>
      <span ref={anchorRef} className={styles.anchor}>
        {triggerRenderer?.({
          open,
          toggle,
          close: () => close(false),
          triggerProps: {
            'aria-haspopup': 'menu',
            'aria-expanded': open,
            onClick: toggle,
            onKeyDown: onTriggerKeyDown,
          },
        })}
      </span>
      <Popover
        open={open}
        onOpenChange={(next) => {
          setOpen(next)
          if (!next) {
            focusTrigger()
          }
        }}
        anchorRef={anchorRef}
        side={side}
        align={align}
        alignOffset={alignOffset}
        offset={offset}
        maxHeight={maxHeight}
        role="menu"
        ariaLabel={ariaLabel}
        className={clsx(styles.menu, className)}
        onKeyDown={onMenuKeyDown}
      >
        <div ref={listRef}>
          {options.map((option) => {
            if (option.type === 'separator') {
              return <hr key={option.key} className={styles.separator} />
            }
            const role =
              option.type === 'radio'
                ? 'menuitemradio'
                : option.type === 'switch'
                  ? 'menuitemcheckbox'
                  : 'menuitem'
            const checked =
              option.type === 'radio' || option.type === 'switch' ? option.checked : undefined
            const isDanger = (!option.type || option.type === 'command') && option.danger
            const shortcut = !option.type || option.type === 'command' ? option.shortcut : undefined
            const keepOpen = option.type === 'switch' && option.keepOpen

            return (
              <button
                key={option.key}
                type="button"
                role={role}
                aria-checked={checked}
                disabled={option.disabled}
                className={clsx(styles.item, isDanger && styles.danger)}
                onMouseMove={(event) => {
                  if (!option.disabled && document.activeElement !== event.currentTarget) {
                    event.currentTarget.focus({ preventScroll: true })
                  }
                }}
                onClick={() => {
                  if (!keepOpen) {
                    close(true)
                  }
                  option.onSelect()
                }}
              >
                {option.icon ? <span className={styles.icon}>{option.icon}</span> : null}
                <span className={styles.label}>{option.label}</span>
                {shortcut ? <span className={styles.shortcut}>{shortcut}</span> : null}
                {checked ? (
                  <span className={styles.check}>
                    <IconCheckOutline16 />
                  </span>
                ) : null}
              </button>
            )
          })}
        </div>
      </Popover>
    </>
  )
}
