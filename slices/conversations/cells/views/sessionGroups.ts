import { DEFAULT_LOCALE, type Translate } from '@deepseek-chat/spine/i18n'
import {
  monthKey,
  translate,
  type SessionSummary,
  type TranslationKey,
} from '../../kernel/index.js'

const DAY = 86_400_000

const startOfDay = (time: number) => new Date(time).setHours(0, 0, 0, 0)

const defaultTranslate: Translate<TranslationKey> = (key, params) =>
  translate(DEFAULT_LOCALE, key, params)

/** 分组：今天 / 昨天 / 7 天内 / 30 天内 / 按月 */
export const groupSessions = (
  sessions: readonly SessionSummary[],
  now: number,
  t: Translate<TranslationKey> = defaultTranslate
) => {
  const groups: { key: string; label: string; sessions: SessionSummary[] }[] = []
  for (const session of sessions) {
    const diff = Math.floor((now - startOfDay(session.updatedAt)) / DAY)
    const key =
      diff <= 0
        ? 'sessionHistoryTimelineLabelToday'
        : diff <= 1
          ? 'sessionHistoryTimelineLabelYesterday'
          : diff < 7
            ? 'sessionHistoryTimelineLabel7days'
            : diff < 30
              ? 'sessionHistoryTimelineLabel30days'
              : null
    const groupKey = key ?? monthKey(session.updatedAt) ?? ''
    const last = groups.at(-1)
    if (last?.key === groupKey) {
      last.sessions.push(session)
    } else {
      groups.push({ key: groupKey, label: key ? t(key) : groupKey, sessions: [session] })
    }
  }
  return groups
}
