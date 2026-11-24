import clsx from 'clsx'
import { forwardRef, type ButtonHTMLAttributes, type ReactNode } from 'react'
import { Tooltip, type TooltipPlacement } from './Tooltip.js'
import styles from './IconButton.module.css'

export type IconButtonSize = 'xs' | 'sm' | 'm' | 'xl'
export type IconButtonTone = 'tertiary' | 'primary'

export type IconButtonProps = {
  icon: ReactNode
  size?: IconButtonSize
  tone?: IconButtonTone
  tooltip?: string
  tooltipPlacement?: TooltipPlacement
  tooltipDisabled?: boolean
} & Omit<ButtonHTMLAttributes<HTMLButtonElement>, 'title'>

/** Circular icon-only action button with optional accessible Tooltip and automatic aria-label. */
export const IconButton = forwardRef<HTMLButtonElement, IconButtonProps>(function IconButton(
  {
    icon,
    size = 'xs',
    tone = 'tertiary',
    tooltip,
    tooltipPlacement,
    tooltipDisabled = false,
    className,
    type = 'button',
    'aria-label': ariaLabel,
    ...props
  },
  ref
) {
  const button = (
    <button
      ref={ref}
      type={type}
      className={clsx(styles.button, styles[size], styles[tone], className)}
      aria-label={ariaLabel ?? tooltip}
      {...props}
    >
      {icon}
    </button>
  )
  return tooltip ? (
    <Tooltip content={tooltip} placement={tooltipPlacement} disabled={tooltipDisabled}>
      {button}
    </Tooltip>
  ) : (
    button
  )
})
