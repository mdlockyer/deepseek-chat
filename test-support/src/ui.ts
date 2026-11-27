import type { NoticeContent, NoticePort } from '@deepseek-chat/spine/ports'

export type MemoryNoticePort = NoticePort & {
  readonly history: readonly NoticeContent[]
  latest(): NoticeContent | null
  clear(): void
}

/** In-memory NoticePort fake for hermetic slice tests. */
export const memoryNoticePort = (): MemoryNoticePort => {
  const entries: NoticeContent[] = []
  return {
    get history() {
      return [...entries]
    },
    show(content) {
      entries.push(content)
    },
    latest() {
      return entries.at(-1) ?? null
    },
    clear() {
      entries.length = 0
    },
  }
}
