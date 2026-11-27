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
  return new Intl.DateTimeFormat(locale, { hour: 'numeric', minute: '2-digit' }).format(date)
}

/** 会话标题：未命名的会话显示默认标签，时间由侧边栏弱化呈现 */
export const sessionTitle = (session: { title: string }, untitledLabel: string): string =>
  session.title || untitledLabel
