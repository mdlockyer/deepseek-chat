import clsx from 'clsx'
import type { ReactNode } from 'react'
import styles from './settings.module.css'

/** Class names of the shared settings layout, for views that compose their own rows. */
export const settingStyles: Readonly<Record<string, string>> = styles

/** A status line under a setting's label; `error` styles it as a failure. */
export type SettingStatus = { readonly text: string; readonly error?: boolean }

/** One settings row: label and description or status on the left, a control on the right. */
export const SettingRow = ({
  label,
  description,
  status = null,
  action,
  className,
}: {
  label: string
  description?: string | undefined
  /** Shown instead of the description when set. */
  status?: SettingStatus | null
  action: ReactNode
  className?: string
}) => (
  <div className={clsx(styles.cell, styles.row, className)}>
    <div className={styles.text}>
      <div className={styles.label}>{label}</div>
      {status || description ? (
        <div className={clsx(styles.description, status?.error && styles.error)}>
          {status ? status.text : description}
        </div>
      ) : null}
    </div>
    {action}
  </div>
)
