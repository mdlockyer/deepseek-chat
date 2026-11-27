import type { Session, SessionStore, SessionSummary } from '@deepseek-chat/slice-conversations'
import { memoryBlobStore, memoryStore } from '@deepseek-chat/test-support'
import { createAppRuntime, type AppRuntimeConfig } from '../runtime.js'

const toSummary = ({ id, title, createdAt, updatedAt }: Session): SessionSummary => ({
  id,
  title,
  createdAt,
  updatedAt,
})

const createOfflineSessionStore = (): SessionStore => {
  const sessions = new Map<string, Session>()
  return {
    loadSummaries: async () => [...sessions.values()].map(toSummary),
    loadSession: async (id) => {
      const found = sessions.get(id)
      return found ? structuredClone(found) : undefined
    },
    saveSession: async (session) => {
      sessions.set(session.id, structuredClone(session))
    },
    renameSession: async (id, title, titleLocked) => {
      const existing = sessions.get(id)
      if (!existing) {
        return
      }
      sessions.set(id, {
        ...existing,
        title,
        ...(titleLocked !== undefined ? { titleLocked } : {}),
      })
    },
    deleteSession: async (id) => {
      sessions.delete(id)
      return []
    },
    replaceAll: async (nextSessions) => {
      sessions.clear()
      for (const session of nextSessions) {
        sessions.set(session.id, structuredClone(session))
      }
      return nextSessions.map(toSummary)
    },
  }
}

/** Dev-only offline AppRuntime factory for workbench demos (uses `@deepseek-chat/test-support`). */
export const createOfflineRuntime = (overrides: Partial<AppRuntimeConfig> = {}) =>
  createAppRuntime({
    store: overrides.store ?? memoryStore(),
    blobs: overrides.blobs ?? memoryBlobStore(),
    sessions: overrides.sessions ?? createOfflineSessionStore(),
    ...overrides,
  })
