const pad = (value: number, length = 2): string => String(value).padStart(length, '0')

const toDate = (value: string | number | Date): Date | null => {
  const date = value instanceof Date ? value : new Date(value)
  return Number.isNaN(date.getTime()) ? null : date
}

export const formatDate = (
  value: string | number | Date,
  separator: '/' | '-' = '-'
): string | null => {
  const date = toDate(value)
  if (!date) {
    return null
  }
  return [pad(date.getFullYear(), 4), pad(date.getMonth() + 1), pad(date.getDate())].join(separator)
}

export const monthKey = (value: string | number | Date): string | null => {
  const date = toDate(value)
  return date ? `${date.getFullYear()}-${pad(date.getMonth() + 1)}` : null
}

/** 当天时间（时:分），用于尚未命名的会话标题 */
export const formatClock = (value: string | number | Date, locale: string): string | null => {
  const date = toDate(value)
  if (!date) {
    return null
  }
  return new Intl.DateTimeFormat(locale, { hour: '2-digit', minute: '2-digit' }).format(date)
}

/** 会话标题：未命名的会话用时间区分，避免列表里出现多个相同的「新对话」 */
export const sessionTitle = (
  session: { title: string; updatedAt: number },
  untitledLabel: string,
  locale: string
): string => {
  if (session.title) {
    return session.title
  }
  const clock = formatClock(session.updatedAt, locale)
  return clock ? `${untitledLabel} · ${clock}` : untitledLabel
}
