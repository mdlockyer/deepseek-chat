import type { Locale } from '@deepseek-chat/spine/i18n'
import { formatDate } from './format.js'
import { translate } from './messages.js'

/**
 * DeepSeek Chat Engine's strict 5-field CSV contract for `latest_reminder`:
 * `<date>,<weekday>,<location>,<platform>,<language>` where `date` is local `YYYY-MM-DD`,
 * `location` may be empty, and `platform` is strictly `'App'` or `'Web'`.
 */
export const createLatestReminder = (
  {
    locale,
    locationLabel,
    platform = 'Web',
  }: { locale: Locale; locationLabel: string; platform?: 'App' | 'Web' },
  now = new Date()
): string => {
  return [
    formatDate(now),
    new Intl.DateTimeFormat(locale, { weekday: 'long' }).format(now),
    locationLabel,
    platform,
    translate('latestReminderLanguage'),
  ].join(',')
}
