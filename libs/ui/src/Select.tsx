import clsx from 'clsx'
import { useCallback, useEffect, useRef, useState, type KeyboardEvent } from 'react'
import { IconCheckOutline16, IconChevronDownOutline14 } from './icons.js'
import { Popover } from './Popover.js'
import styles from './Select.module.css'

export type SelectOption<T extends string> = {
  readonly value: T
  readonly label: string
  readonly lang?: string
}

export type SelectProps<T extends string> = {
  value: T
  options: readonly SelectOption<T>[]
  onChange: (value: T) => void
  placeholder?: string
  ariaLabel?: string
  className?: string
  disabled?: boolean
}

const getOptionButtons = (root: HTMLElement | null): HTMLButtonElement[] =>
  root ? Array.from(root.querySelectorAll<HTMLButtonElement>('button[role="option"]')) : []

/**
 * Pill selector built on Popover: uses native `<button role="option">` items, keyboard
 * Arrow/Home/End/Escape navigation (capturing Escape before parent Dialogs), and `lang` support.
 */
export const Select = <T extends string>({
  value,
  options,
  onChange,
  placeholder,
  ariaLabel,
  className,
  disabled = false,
}: SelectProps<T>) => {
  const [open, setOpen] = useState(false)
  const triggerRef = useRef<HTMLButtonElement>(null)
  const listRef = useRef<HTMLDivElement>(null)
  const current = options.find((option) => option.value === value)

  useEffect(() => {
    if (!open) {
      return
    }
    const frame = requestAnimationFrame(() => {
      const buttons = getOptionButtons(listRef.current)
      const selectedIndex = options.findIndex((option) => option.value === value)
      const target = buttons[selectedIndex >= 0 ? selectedIndex : 0]
      target?.focus({ preventScroll: true })
    })
    return () => cancelAnimationFrame(frame)
  }, [open, options, value])

  const onTriggerKeyDown = useCallback(
    (event: KeyboardEvent<HTMLButtonElement>) => {
      if (disabled) {
        return
      }
      if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
        event.preventDefault()
        setOpen(true)
      }
    },
    [disabled]
  )

  const onListKeyDown = useCallback((event: KeyboardEvent<HTMLDivElement>) => {
    const buttons = getOptionButtons(listRef.current)
    if (buttons.length === 0) {
      return
    }
    const currentIndex = buttons.indexOf(document.activeElement as HTMLButtonElement)
    if (event.key === 'ArrowDown') {
      event.preventDefault()
      buttons[(currentIndex + 1) % buttons.length]?.focus({ preventScroll: true })
    } else if (event.key === 'ArrowUp') {
      event.preventDefault()
      buttons[(currentIndex - 1 + buttons.length) % buttons.length]?.focus({ preventScroll: true })
    } else if (event.key === 'Home') {
      event.preventDefault()
      buttons[0]?.focus({ preventScroll: true })
    } else if (event.key === 'End') {
      event.preventDefault()
      buttons.at(-1)?.focus({ preventScroll: true })
    } else if (event.key === 'Tab') {
      setOpen(false)
    }
  }, [])

  return (
    <>
      <button
        ref={triggerRef}
        type="button"
        className={clsx(styles.trigger, open && styles.open, className)}
        aria-label={ariaLabel}
        aria-haspopup="listbox"
        aria-expanded={open}
        disabled={disabled}
        onClick={() => setOpen((prev) => !prev)}
        onKeyDown={onTriggerKeyDown}
      >
        {current ? (
          <span lang={current.lang}>{current.label}</span>
        ) : (
          <span className={styles.placeholder}>{placeholder}</span>
        )}
        <span className={styles.arrow} aria-hidden="true">
          <IconChevronDownOutline14 />
        </span>
      </button>
      <Popover
        open={open && !disabled}
        onOpenChange={setOpen}
        anchorRef={triggerRef}
        align="end"
        offset={4}
        maxHeight={320}
        minSpace={160}
        captureEscape
        role="listbox"
        ariaLabel={ariaLabel}
        className={styles.menu}
        onKeyDown={onListKeyDown}
      >
        <div ref={listRef}>
          {options.map((option) => {
            const selected = option.value === value
            return (
              <button
                key={option.value}
                type="button"
                role="option"
                lang={option.lang}
                aria-selected={selected}
                className={styles.option}
                onClick={() => {
                  setOpen(false)
                  onChange(option.value)
                  requestAnimationFrame(() => triggerRef.current?.focus({ preventScroll: true }))
                }}
              >
                <span>{option.label}</span>
                {selected ? (
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
