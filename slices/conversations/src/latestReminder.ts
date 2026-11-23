import type { Locale } from '@deepseek-chat/spine/i18n'
import { formatDate } from './format.js'
import { translate } from './messages.js'

/**
 * Dynamic per-round environment snapshot sent in `latest_reminder` (kept out of `system` so the
 * prompt prefix stays cacheable across turns). Uses local browser/OS date and timezone.
 */
export const createLatestReminder = (
  {
    locale,
    locationLabel,
    platform = 'Web',
  }: { locale: Locale; locationLabel: string; platform?: string },
  now = new Date()
): string => {
  const weekday = new Intl.DateTimeFormat(locale, { weekday: 'long' }).format(now)
  const timeZone = Intl.DateTimeFormat().resolvedOptions().timeZone
  const parts = [`Date: ${formatDate(now)} (${weekday})`]
  if (timeZone) {
    parts.push(`Timezone: ${timeZone}`)
  }
  parts.push(`Platform: ${platform}`)
  if (locationLabel) {
    parts.push(`Location: ${locationLabel}`)
  }
  parts.push(`UI Language: ${translate('latestReminderLanguage')}`)
  return parts.join(' | ')
}
