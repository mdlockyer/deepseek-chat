import clsx from 'clsx'
import { useCallback, useRef, type KeyboardEvent, type ReactNode } from 'react'
import styles from './RadioCardGroup.module.css'

export type RadioCardOption<T extends string> = {
  readonly value: T
  readonly label: ReactNode
  readonly icon?: ReactNode
  readonly description?: ReactNode
  readonly disabled?: boolean
}

export type RadioCardGroupProps<T extends string> = {
  value: T
  options: readonly RadioCardOption<T>[]
  onChange: (value: T) => void
  ariaLabel?: string
  ariaLabelledBy?: string
  className?: string
  cardClassName?: string
}

/** Accessible card-style radio selector (`role="radiogroup"` + arrow-key roving `role="radio"`). */
export const RadioCardGroup = <T extends string>({
  value,
  options,
  onChange,
  ariaLabel,
  ariaLabelledBy,
  className,
  cardClassName,
}: RadioCardGroupProps<T>) => {
  const groupRef = useRef<HTMLDivElement>(null)

  const onKeyDown = useCallback((event: KeyboardEvent<HTMLDivElement>) => {
    const root = groupRef.current
    if (!root) {
      return
    }
    const radios = Array.from(
      root.querySelectorAll<HTMLButtonElement>('button[role="radio"]:not(:disabled)')
    )
    if (radios.length === 0) {
      return
    }
    const index = radios.indexOf(document.activeElement as HTMLButtonElement)
    if (index < 0) {
      return
    }
    let next: HTMLButtonElement | undefined
    if (event.key === 'ArrowRight' || event.key === 'ArrowDown') {
      next = radios[(index + 1) % radios.length]
    } else if (event.key === 'ArrowLeft' || event.key === 'ArrowUp') {
      next = radios[(index - 1 + radios.length) % radios.length]
    }
    if (next) {
      event.preventDefault()
      next.focus({ preventScroll: true })
      next.click()
    }
  }, [])

  return (
    <div
      ref={groupRef}
      role="radiogroup"
      aria-label={ariaLabel}
      aria-labelledby={ariaLabelledBy}
      className={clsx(styles.group, className)}
      onKeyDown={onKeyDown}
    >
      {options.map((option) => {
        const selected = option.value === value
        return (
          <button
            key={option.value}
            type="button"
            role="radio"
            aria-checked={selected}
            tabIndex={selected ? 0 : -1}
            disabled={option.disabled}
            className={clsx(styles.card, selected && styles.selected, cardClassName)}
            onClick={() => {
              if (!option.disabled) {
                onChange(option.value)
              }
            }}
          >
            {option.icon ? (
              <span className={styles.icon} aria-hidden="true">
                {option.icon}
              </span>
            ) : null}
            <span>{option.label}</span>
            {option.description ? (
              <span className={styles.description}>{option.description}</span>
            ) : null}
          </button>
        )
      })}
    </div>
  )
}
