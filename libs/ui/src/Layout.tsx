import clsx from 'clsx'
import type { ReactNode } from 'react'
import { Button, type ButtonVariant } from './Button.js'
import styles from './Layout.module.css'

/** Status line beneath a setting label; `error` styles it in the danger token. */
export type SettingStatus = {
  readonly text: string
  readonly error?: boolean
}

export type SettingGroupProps = {
  className?: string
  children?: ReactNode
}

/** Vertical container separating stacked `SettingRow` items with hairline dividers. */
export const SettingGroup = ({ className, children }: SettingGroupProps) => (
  <div className={clsx(styles.settingGroup, className)}>{children}</div>
)

export type SettingRowProps = {
  label?: ReactNode
  description?: ReactNode
  status?: SettingStatus | null
  action?: ReactNode
  /** Stacks body/action vertically below the label (used for card groups or secret editors). */
  stack?: boolean
  className?: string
  children?: ReactNode
}

export const SettingRow = ({
  label,
  description,
  status = null,
  action,
  stack = false,
  className,
  children,
}: SettingRowProps) => (
  <div className={clsx(styles.settingRow, stack && styles.settingRowStack, className)}>
    {label || status || description ? (
      <div className={styles.settingText}>
        {label ? <div className={styles.settingLabel}>{label}</div> : null}
        {status || description ? (
          <div className={clsx(styles.settingDescription, status?.error && styles.settingError)}>
            {status ? status.text : description}
          </div>
        ) : null}
      </div>
    ) : null}
    {children}
    {action ? <div className={styles.settingAction}>{action}</div> : null}
  </div>
)

export type SettingInlineConfirmProps = {
  confirming: boolean
  triggerLabel: string
  confirmLabel: string
  cancelLabel: string
  triggerVariant?: ButtonVariant
  confirmVariant?: ButtonVariant
  disabled?: boolean
  busy?: boolean
  onOpen: () => void
  onConfirm: () => void
  onCancel: () => void
}

/** Inline two-step destructive confirmation inside a settings row. */
export const SettingInlineConfirm = ({
  confirming,
  triggerLabel,
  confirmLabel,
  cancelLabel,
  triggerVariant = 'dangerOutlined',
  confirmVariant = 'danger',
  disabled = false,
  busy = false,
  onOpen,
  onConfirm,
  onCancel,
}: SettingInlineConfirmProps) =>
  confirming ? (
    <div className={styles.inlineConfirm}>
      <Button variant="outlined" size="m" disabled={busy} onClick={onCancel}>
        {cancelLabel}
      </Button>
      <Button variant={confirmVariant} size="m" loading={busy} disabled={busy} onClick={onConfirm}>
        {confirmLabel}
      </Button>
    </div>
  ) : (
    <Button variant={triggerVariant} size="m" disabled={disabled || busy} onClick={onOpen}>
      {triggerLabel}
    </Button>
  )

export type PanelHeaderProps = {
  title: ReactNode
  subtitle?: ReactNode
  leading?: ReactNode
  actions?: ReactNode
  className?: string
}

/** Standardized side-panel top chrome bar with desktop window drag-region support. */
export const PanelHeader = ({ title, subtitle, leading, actions, className }: PanelHeaderProps) => (
  <header className={clsx(styles.panelHeader, className)} data-tauri-drag-region="">
    <div className={styles.panelHeaderMain} data-tauri-drag-region="">
      {leading}
      <div className={styles.panelHeaderText}>
        <div className={styles.panelTitle}>{title}</div>
        {subtitle ? <div className={styles.panelSubtitle}>{subtitle}</div> : null}
      </div>
    </div>
    {actions ? <div className={styles.panelActions}>{actions}</div> : null}
  </header>
)
