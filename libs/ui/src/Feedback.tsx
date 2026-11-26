import clsx from 'clsx'
import type { ReactNode } from 'react'
import { IconCheckOutline16 } from './icons.js'
import { uiMessages } from './messages.js'
import styles from './Feedback.module.css'

export type BadgeTone = 'neutral' | 'accent' | 'success' | 'warning' | 'danger'

export type BadgeProps = {
  tone?: BadgeTone
  icon?: ReactNode
  className?: string
  children?: ReactNode
}

const BADGE_TONE_CLASS: Record<BadgeTone, string> = {
  neutral: styles.badgeNeutral,
  accent: styles.badgeAccent,
  success: styles.badgeSuccess,
  warning: styles.badgeWarning,
  danger: styles.badgeDanger,
}

/**
 * Success shares a green family with the accent, so success badges and banners always show a
 * check mark (unless the caller passes its own icon): the colour is never the only signal.
 */
const withSuccessIcon = (tone: string, icon: ReactNode | undefined): ReactNode =>
  icon ?? (tone === 'success' ? <IconCheckOutline16 /> : undefined)

export const Badge = ({ tone = 'neutral', icon, className, children }: BadgeProps) => (
  <span className={clsx(styles.badge, BADGE_TONE_CLASS[tone], className)}>
    {withSuccessIcon(tone, icon)}
    <span>{children}</span>
  </span>
)

export type BannerTone = 'info' | 'warning' | 'error' | 'success'

export type BannerProps = {
  tone?: BannerTone
  icon?: ReactNode
  action?: ReactNode
  compact?: boolean
  role?: 'alert' | 'status' | 'note'
  className?: string
  children?: ReactNode
}

const BANNER_TONE_CLASS: Record<BannerTone, string> = {
  info: styles.bannerInfo,
  warning: styles.bannerWarning,
  error: styles.bannerError,
  success: styles.bannerSuccess,
}

export const Banner = ({
  tone = 'info',
  icon,
  action,
  compact = false,
  role,
  className,
  children,
}: BannerProps) => {
  const bannerIcon = withSuccessIcon(tone, icon)
  return (
    <div
      role={role ?? (tone === 'error' ? 'alert' : 'status')}
      className={clsx(
        styles.banner,
        BANNER_TONE_CLASS[tone],
        compact && styles.bannerCompact,
        className
      )}
    >
      {bannerIcon ? (
        <span className={styles.bannerIcon} aria-hidden="true">
          {bannerIcon}
        </span>
      ) : null}
      <div className={styles.bannerBody}>{children}</div>
      {action ? <div className={styles.bannerAction}>{action}</div> : null}
    </div>
  )
}

export type EmptyStateProps = {
  icon?: ReactNode
  title: ReactNode
  description?: ReactNode
  action?: ReactNode
  compact?: boolean
  className?: string
}

export const EmptyState = ({
  icon,
  title,
  description,
  action,
  compact = false,
  className,
}: EmptyStateProps) => (
  <div className={clsx(styles.empty, compact && styles.emptyCompact, className)}>
    {icon ? <div className={styles.emptyIcon}>{icon}</div> : null}
    <div className={styles.emptyTitle}>{title}</div>
    {description ? <div className={styles.emptyDescription}>{description}</div> : null}
    {action ? <div className={styles.emptyAction}>{action}</div> : null}
  </div>
)

export type SpinnerSize = 'sm' | 'md' | 'lg'

export type SpinnerProps = {
  size?: SpinnerSize
  label?: string
  className?: string
}

const SPINNER_SIZE_CLASS: Record<SpinnerSize, string> = {
  sm: styles.spinnerSm,
  md: styles.spinnerMd,
  lg: styles.spinnerLg,
}

export const Spinner = ({ size = 'md', label, className }: SpinnerProps) => {
  const t = uiMessages.useTranslate()
  return (
    <span
      role="status"
      aria-label={label ?? t('loading')}
      className={clsx(styles.spinner, SPINNER_SIZE_CLASS[size], className)}
    />
  )
}
