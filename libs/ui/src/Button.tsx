import clsx from 'clsx'
import type { AnchorHTMLAttributes, ButtonHTMLAttributes, ReactNode } from 'react'
import styles from './Button.module.css'

export type ButtonVariant =
  | 'primary'
  | 'secondary'
  | 'outlined'
  | 'ghost'
  | 'danger'
  | 'dangerOutlined'
export type ButtonSize = 'l' | 'm' | 's'

export type ButtonProps = {
  variant?: ButtonVariant
  size?: ButtonSize
  block?: boolean
  loading?: boolean
  icon?: ReactNode
} & ButtonHTMLAttributes<HTMLButtonElement>

export const Button = ({
  variant = 'primary',
  size = 'l',
  block = false,
  loading = false,
  disabled = false,
  icon,
  className,
  type = 'button',
  children,
  ...props
}: ButtonProps) => (
  <button
    type={type}
    disabled={disabled || loading}
    aria-busy={loading || undefined}
    className={clsx(styles.button, styles[variant], styles[size], block && styles.block, className)}
    {...props}
  >
    {loading ? <span className={styles.spinner} aria-hidden="true" /> : icon}
    {children}
  </button>
)

export type LinkButtonProps = {
  variant?: ButtonVariant
  size?: ButtonSize
  block?: boolean
} & AnchorHTMLAttributes<HTMLAnchorElement>

/** Anchor styled with the same token grammar as Button (for external/navigation links). */
export const LinkButton = ({
  variant = 'outlined',
  size = 'm',
  block = false,
  className,
  ...props
}: LinkButtonProps) => (
  <a
    className={clsx(styles.button, styles[variant], styles[size], block && styles.block, className)}
    {...props}
  />
)
