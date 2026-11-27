import type { Session, SessionStore, SessionSummary } from '@deepseek-chat/slice-conversations'

const collectSessionFileIds = (session: Session): string[] => {
  const ids = new Set<string>()
  for (const message of session.messages) {
    if (message.role === 'user') {
      for (const file of message.files) {
        ids.add(file.id)
      }
      continue
    }
    for (const block of message.blocks) {
      if (block.type === 'tool_result' && block.files) {
        for (const file of block.files) {
          ids.add(file.id)
        }
      }
    }
  }
  return [...ids]
}

type StoredSummary = SessionSummary & { readonly fileIds: readonly string[] }

const storedSummary = (session: Session): StoredSummary => ({
  id: session.id,
  title: session.title,
  createdAt: session.createdAt,
  updatedAt: session.updatedAt,
  fileIds: collectSessionFileIds(session),
})

const toSummary = ({ id, title, createdAt, updatedAt }: StoredSummary): SessionSummary => ({
  id,
  title,
  createdAt,
  updatedAt,
})

/** Hermetic in-memory SessionStore fake for conversations boundary tests. */
export const memorySessionStore = (initial: readonly Session[] = []): SessionStore => {
  const sessions = new Map<string, Session>()
  const summaries = new Map<string, StoredSummary>()
  for (const session of initial) {
    const copy = structuredClone(session)
    sessions.set(copy.id, copy)
    summaries.set(copy.id, storedSummary(copy))
  }

  return {
    loadSummaries: async () => [...summaries.values()].map(toSummary),
    loadSession: async (id) => {
      const found = sessions.get(id)
      return found ? structuredClone(found) : undefined
    },
    saveSession: async (session) => {
      const copy = structuredClone(session)
      sessions.set(copy.id, copy)
      summaries.set(copy.id, storedSummary(copy))
    },
    renameSession: async (id, title, titleLocked) => {
      const existing = sessions.get(id)
      if (!existing) {
        return
      }
      const next: Session = {
        ...existing,
        title,
        ...(titleLocked !== undefined ? { titleLocked } : {}),
      }
      sessions.set(id, next)
      summaries.set(id, storedSummary(next))
    },
    deleteSession: async (id) => {
      const summary = summaries.get(id)
      sessions.delete(id)
      summaries.delete(id)
      const remaining = new Set<string>()
      for (const item of summaries.values()) {
        for (const fileId of item.fileIds) {
          remaining.add(fileId)
        }
      }
      return (summary?.fileIds ?? []).filter((fileId) => !remaining.has(fileId))
    },
    replaceAll: async (nextSessions) => {
      sessions.clear()
      summaries.clear()
      const list: SessionSummary[] = []
      for (const session of nextSessions) {
        const copy = structuredClone(session)
        const summary = storedSummary(copy)
        sessions.set(copy.id, copy)
        summaries.set(copy.id, summary)
        list.push(toSummary(summary))
      }
      return list
    },
  }
}
