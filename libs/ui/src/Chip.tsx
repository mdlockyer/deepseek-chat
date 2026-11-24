import clsx from 'clsx'
import { forwardRef, type ButtonHTMLAttributes, type ReactNode } from 'react'
import styles from './Chip.module.css'

export type ChipProps = {
  icon?: ReactNode
  trailing?: ReactNode
  active?: boolean
  ghost?: boolean
  compactOnNarrow?: boolean
} & ButtonHTMLAttributes<HTMLButtonElement>

/** Compact interactive toolbar/mode/filter pill built on native `<button>`. */
export const Chip = forwardRef<HTMLButtonElement, ChipProps>(function Chip(
  {
    icon,
    trailing,
    active = false,
    ghost = false,
    compactOnNarrow = false,
    className,
    type = 'button',
    children,
    ...props
  },
  ref
) {
  return (
    <button
      ref={ref}
      type={type}
      className={clsx(
        styles.chip,
        ghost && styles.ghost,
        active && styles.active,
        compactOnNarrow && styles.compactOnNarrow,
        className
      )}
      {...props}
    >
      {icon}
      {children !== undefined && children !== null ? (
        <span className={styles.label}>{children}</span>
      ) : null}
      {trailing}
    </button>
  )
})
