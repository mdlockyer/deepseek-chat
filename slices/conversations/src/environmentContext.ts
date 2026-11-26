import type { Locale } from '@deepseek-chat/spine/i18n'
import { formatDate } from './format.js'
import { translate } from './messages.js'

/**
 * Dynamic per-turn environment snapshot injected into a standard `user` message only when it first
 * appears or changes, keeping the static `system` prompt KV-cacheable across turns on any provider.
 */
export const createEnvironmentContext = (
  {
    locale,
    locationLabel,
    platform = 'web',
  }: { locale: Locale; locationLabel: string; platform?: 'desktop' | 'web' },
  now = new Date()
): string => {
  const weekday = new Intl.DateTimeFormat(locale, { weekday: 'long' }).format(now)
  const trimmedLocation = locationLabel.trim()
  const lines = [
    `Date: ${formatDate(now)} (${weekday})`,
    `Platform: ${platform === 'desktop' ? 'Desktop app' : 'Web browser'}`,
    ...(trimmedLocation ? [`Location: ${trimmedLocation}`] : []),
    `Language: ${translate('environmentContextLanguage')}`,
  ]
  return `<environment_context>\n${lines.join('\n')}\n</environment_context>`
}

/**
 * Converts a legacy persisted 5-field `latestReminder` CSV (`<date>,<weekday>,<location>,<App|Web>,<language>`)
 * into a standard `<environment_context>` block so older IndexedDB sessions never emit `role: 'latest_reminder'`.
 */
export const formatLegacyLatestReminder = (csv: string): string => {
  const trimmed = csv.trim()
  if (!trimmed) {
    return ''
  }
  if (trimmed.startsWith('<environment_context>')) {
    return trimmed
  }
  const [date, weekday, location, platform, language] = trimmed.split(',')
  if (!date || !weekday) {
    return `<environment_context>\n${trimmed}\n</environment_context>`
  }
  const lines = [
    `Date: ${date} (${weekday})`,
    ...(platform ? [`Platform: ${platform === 'App' ? 'Desktop app' : 'Web browser'}`] : []),
    ...(location?.trim() ? [`Location: ${location.trim()}`] : []),
    ...(language?.trim() ? [`Language: ${language.trim()}`] : []),
  ]
  return `<environment_context>\n${lines.join('\n')}\n</environment_context>`
}

/** Resolves the canonical environment context snapshot recorded on a reply (with legacy fallback). */
export const resolveEnvironmentContext = (reply: {
  readonly environmentContext?: string
  readonly latestReminder?: string
}): string | undefined => {
  if (reply.environmentContext?.trim()) {
    return reply.environmentContext
  }
  if (reply.latestReminder?.trim()) {
    return formatLegacyLatestReminder(reply.latestReminder)
  }
  return undefined
}
