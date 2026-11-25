import clsx from 'clsx'
import type { ReactNode } from 'react'
import styles from './SegmentedControl.module.css'

export type SegmentedOption<T extends string> = {
  readonly value: T
  readonly label: ReactNode
  readonly icon?: ReactNode
  readonly disabled?: boolean
}

export type SegmentedControlProps<T extends string> = {
  value: T
  options: readonly SegmentedOption<T>[]
  onChange: (value: T) => void
  ariaLabel?: string
  size?: 'sm' | 'md'
  className?: string
}

/** Mutually-exclusive view/mode toggle group (`role="group"` + `<button aria-pressed>`). */
export const SegmentedControl = <T extends string>({
  value,
  options,
  onChange,
  ariaLabel,
  size = 'sm',
  className,
}: SegmentedControlProps<T>) => (
  <div
    role="group"
    aria-label={ariaLabel}
    className={clsx(styles.group, size === 'md' && styles.md, className)}
  >
    {options.map((option) => {
      const selected = option.value === value
      return (
        <button
          key={option.value}
          type="button"
          aria-pressed={selected}
          disabled={option.disabled}
          className={clsx(styles.item, selected && styles.active)}
          onClick={() => {
            if (!selected && !option.disabled) {
              onChange(option.value)
            }
          }}
        >
          {option.icon}
          {option.label}
        </button>
      )
    })}
  </div>
)
