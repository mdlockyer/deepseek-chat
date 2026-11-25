import clsx from 'clsx'
import { forwardRef, useId, useState, type InputHTMLAttributes, type ReactNode } from 'react'
import { IconButton } from './IconButton.js'
import { IconEyeOffOutline16, IconEyeOutline16 } from './icons.js'
import { uiMessages } from './messages.js'
import styles from './Field.module.css'

export type TextFieldProps = {
  label?: string
  hint?: string
  error?: string | null
  leading?: ReactNode
  trailing?: ReactNode
  compact?: boolean
  monospace?: boolean
  containerClassName?: string
  boxClassName?: string
} & Omit<InputHTMLAttributes<HTMLInputElement>, 'size'>

/**
 * Accessible text input with visible `<label htmlFor>`, hint placed above the field
 * (never obscured by browser autofill), `aria-describedby`, and `role="alert"` error message.
 */
export const TextField = forwardRef<HTMLInputElement, TextFieldProps>(function TextField(
  {
    id,
    label,
    hint,
    error,
    leading,
    trailing,
    compact = false,
    monospace = false,
    containerClassName,
    boxClassName,
    className,
    'aria-describedby': describedByProp,
    ...props
  },
  ref
) {
  const generatedId = useId()
  const inputId = id ?? generatedId
  const hintId = hint ? `${inputId}-hint` : undefined
  const errorId = error ? `${inputId}-error` : undefined
  const describedBy = [describedByProp, hintId, errorId].filter(Boolean).join(' ') || undefined

  return (
    <div className={clsx(styles.field, containerClassName)}>
      {label ? (
        <label htmlFor={inputId} className={styles.label}>
          {label}
        </label>
      ) : null}
      {hint ? (
        <div id={hintId} className={styles.hint}>
          {hint}
        </div>
      ) : null}
      <div
        className={clsx(
          styles.box,
          compact && styles.compact,
          error && styles.boxError,
          boxClassName
        )}
      >
        {leading ? <span className={styles.slot}>{leading}</span> : null}
        <input
          ref={ref}
          id={inputId}
          aria-invalid={error ? true : undefined}
          aria-describedby={describedBy}
          className={clsx(styles.input, monospace && styles.monospace, className)}
          {...props}
        />
        {trailing ? <span className={styles.slot}>{trailing}</span> : null}
      </div>
      {error ? (
        <div id={errorId} role="alert" className={styles.errorRow}>
          <span>{error}</span>
        </div>
      ) : null}
    </div>
  )
})

export type PasswordFieldProps = Omit<TextFieldProps, 'type' | 'trailing'> & {
  showLabel?: string
  hideLabel?: string
  revealed?: boolean
  onRevealedChange?: (revealed: boolean) => void
}

/**
 * Secret / password field with accessible reveal toggle. Preserves clipboard paste
 * and password manager autocomplete per WCAG 3.3.8.
 */
export const PasswordField = forwardRef<HTMLInputElement, PasswordFieldProps>(
  function PasswordField(
    {
      showLabel,
      hideLabel,
      revealed: controlledRevealed,
      onRevealedChange,
      autoComplete = 'off',
      spellCheck = false,
      ...props
    },
    ref
  ) {
    const t = uiMessages.useTranslate()
    const [uncontrolledRevealed, setUncontrolledRevealed] = useState(false)
    const revealed = controlledRevealed ?? uncontrolledRevealed
    const setRevealed = (next: boolean) => {
      setUncontrolledRevealed(next)
      onRevealedChange?.(next)
    }

    const labelShow = showLabel ?? t('showPassword')
    const labelHide = hideLabel ?? t('hidePassword')

    return (
      <TextField
        ref={ref}
        type={revealed ? 'text' : 'password'}
        autoComplete={autoComplete}
        spellCheck={spellCheck}
        trailing={
          <IconButton
            icon={revealed ? <IconEyeOffOutline16 /> : <IconEyeOutline16 />}
            aria-label={revealed ? labelHide : labelShow}
            tooltip={revealed ? labelHide : labelShow}
            onClick={() => setRevealed(!revealed)}
          />
        }
        {...props}
      />
    )
  }
)
