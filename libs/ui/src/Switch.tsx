import clsx from 'clsx'
import { forwardRef, type ButtonHTMLAttributes, type ReactNode } from 'react'
import styles from './Switch.module.css'

export type SwitchProps = {
  checked: boolean
  onChange: (checked: boolean) => void
  label?: ReactNode
  icon?: ReactNode
  trailing?: ReactNode
  block?: boolean
} & Omit<ButtonHTMLAttributes<HTMLButtonElement>, 'onChange' | 'role' | 'children'>

/** Native accessible toggle switch (`<button type="button" role="switch" aria-checked>`). */
export const Switch = forwardRef<HTMLButtonElement, SwitchProps>(function Switch(
  {
    checked,
    onChange,
    label,
    icon,
    trailing,
    block = false,
    disabled = false,
    className,
    onClick,
    ...props
  },
  ref
) {
  const bare = !label && !icon && !trailing
  return (
    <button
      ref={ref}
      type="button"
      role="switch"
      aria-checked={checked}
      disabled={disabled}
      className={clsx(styles.button, block && styles.block, bare && styles.bare, className)}
      onClick={(event) => {
        onClick?.(event)
        if (!event.defaultPrevented && !disabled) {
          onChange(!checked)
        }
      }}
      {...props}
    >
      {icon ? (
        <span className={clsx(styles.icon, checked && styles.iconChecked)} aria-hidden="true">
          {icon}
        </span>
      ) : null}
      {label ? <span className={styles.label}>{label}</span> : null}
      {trailing}
      <span className={clsx(styles.track, checked && styles.trackChecked)} aria-hidden="true">
        <span className={styles.thumb} />
      </span>
    </button>
  )
})
