import type { Locale } from '@deepseek-chat/spine/i18n'
import { formatDate } from './format.js'
import { translate } from './messages.js'

/**
 * 模型约定的五项信息；日期与星期使用浏览器本地时区，避免 UTC 日期跨日。
 * `locationLabel` 由 preferences slice 按当前语言给出，未设置时为空串。
 */
export const createLatestReminder = (
  { locale, locationLabel }: { locale: Locale; locationLabel: string },
  now = new Date()
): string => {
  return [
    formatDate(now),
    new Intl.DateTimeFormat(locale, { weekday: 'long' }).format(now),
    locationLabel,
    'Web',
    translate('latestReminderLanguage'),
  ].join(',')
}
