import { openDB, type DBSchema, type IDBPDatabase } from 'idb'
import { toSessionSummary, type Session, type SessionSummary } from './types.js'

/** Storage port owned by `slices/conversations`. Blobs live separately in Spine `BlobStore`. */
export type SessionStore = {
  loadSummaries(): Promise<SessionSummary[]>
  loadSession(id: string): Promise<Session | undefined>
  saveSession(session: Session): Promise<void>
  renameSession(id: string, title: string, titleLocked?: boolean): Promise<void>
  /** Deletes a session and returns blob IDs no longer referenced by any remaining session. */
  deleteSession(id: string): Promise<string[]>
  /** Atomically replaces every stored session and returns the new summaries. */
  replaceAll(sessions: readonly Session[]): Promise<SessionSummary[]>
  /** Releases any open underlying storage handle. */
  close?(): void
}

type StoredSessionSummary = SessionSummary & { fileIds: string[] }

interface SessionsDB extends DBSchema {
  sessions: { key: string; value: Session }
  sessionSummaries: {
    key: string
    value: StoredSessionSummary
    indexes: { fileIds: string }
  }
}

const collectSessionFileIds = (session: Session): string[] => [
  ...new Set(
    session.messages.flatMap((message) =>
      message.role === 'user'
        ? message.files.map((file) => file.id)
        : message.blocks.flatMap((block) =>
            block.type === 'tool_result' ? (block.files ?? []).map((file) => file.id) : []
          )
    )
  ),
]

const storedSummary = (session: Session): StoredSessionSummary => ({
  ...toSessionSummary(session),
  fileIds: collectSessionFileIds(session),
})

const abortTransaction = (tx: { abort(): void }) => {
  try {
    tx.abort()
  } catch {
    // Transaction already aborted.
  }
}

/**
 * Factory-scoped IndexedDB `SessionStore` (clean v1 schema: `sessions` + `sessionSummaries`).
 * Holds its connection inside the returned closure so multiple slice instances stay isolated.
 */
export const createIndexedDbSessionStore = (dbName = 'deepseek-sessions'): SessionStore => {
  let dbPromise: Promise<IDBPDatabase<SessionsDB>> | null = null

  const getDB = () =>
    (dbPromise ??= openDB<SessionsDB>(dbName, 1, {
      upgrade(db, _oldVersion, _newVersion, tx) {
        if (!db.objectStoreNames.contains('sessions')) {
          db.createObjectStore('sessions', { keyPath: 'id' })
        }
        const summaries = db.objectStoreNames.contains('sessionSummaries')
          ? tx.objectStore('sessionSummaries')
          : db.createObjectStore('sessionSummaries', { keyPath: 'id' })
        if (!summaries.indexNames.contains('fileIds')) {
          summaries.createIndex('fileIds', 'fileIds', { multiEntry: true })
        }
      },
    }).catch((error: unknown) => {
      dbPromise = null
      throw error
    }))

  return {
    loadSummaries: async () =>
      (await (await getDB()).getAll('sessionSummaries')).map(toSessionSummary),

    loadSession: async (id) => (await getDB()).get('sessions', id),

    saveSession: async (session) => {
      const summary = storedSummary(session)
      const tx = (await getDB()).transaction(['sessions', 'sessionSummaries'], 'readwrite')
      await Promise.all([
        (async () => {
          try {
            await tx.objectStore('sessions').put(session)
            await tx.objectStore('sessionSummaries').put(summary)
          } catch (error) {
            abortTransaction(tx)
            throw error
          }
        })(),
        tx.done,
      ])
    },

    renameSession: async (id, title, titleLocked) => {
      const tx = (await getDB()).transaction(['sessions', 'sessionSummaries'], 'readwrite')
      await Promise.all([
        (async () => {
          try {
            const sessions = tx.objectStore('sessions')
            const session = await sessions.get(id)
            if (session) {
              session.title = title
              if (titleLocked !== undefined) {
                session.titleLocked = titleLocked
              }
              await sessions.put(session)
              await tx.objectStore('sessionSummaries').put(storedSummary(session))
            }
          } catch (error) {
            abortTransaction(tx)
            throw error
          }
        })(),
        tx.done,
      ])
    },

    deleteSession: async (sessionId) => {
      const orphaned: string[] = []
      const tx = (await getDB()).transaction(['sessions', 'sessionSummaries'], 'readwrite')
      await Promise.all([
        (async () => {
          try {
            const summaries = tx.objectStore('sessionSummaries')
            const summary = await summaries.get(sessionId)
            await tx.objectStore('sessions').delete(sessionId)
            await summaries.delete(sessionId)
            for (const fileId of summary?.fileIds ?? []) {
              if ((await summaries.index('fileIds').count(fileId)) === 0) {
                orphaned.push(fileId)
              }
            }
          } catch (error) {
            abortTransaction(tx)
            throw error
          }
        })(),
        tx.done,
      ])
      return orphaned
    },

    replaceAll: async (nextSessions) => {
      const summaries: SessionSummary[] = []
      const tx = (await getDB()).transaction(['sessions', 'sessionSummaries'], 'readwrite')
      await Promise.all([
        (async () => {
          try {
            const sessionsStore = tx.objectStore('sessions')
            const summariesStore = tx.objectStore('sessionSummaries')
            await sessionsStore.clear()
            await summariesStore.clear()
            for (const session of nextSessions) {
              const summary = storedSummary(session)
              await sessionsStore.put(session)
              await summariesStore.put(summary)
              summaries.push(toSessionSummary(summary))
            }
          } catch (error) {
            abortTransaction(tx)
            throw error
          }
        })(),
        tx.done,
      ])
      return summaries
    },

    close: () => {
      const current = dbPromise
      dbPromise = null
      if (current) {
        void current.then((db) => db.close()).catch(() => {})
      }
    },
  }
}

/** Hermetic in-memory `SessionStore` for unit tests and isolated multi-instance demos. */
export const memorySessionStore = (initial: readonly Session[] = []): SessionStore => {
  const sessions = new Map<string, Session>()
  const summaries = new Map<string, StoredSessionSummary>()
  for (const session of initial) {
    const copy = structuredClone(session)
    sessions.set(copy.id, copy)
    summaries.set(copy.id, storedSummary(copy))
  }

  return {
    loadSummaries: async () => [...summaries.values()].map(toSessionSummary),
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
        list.push(toSessionSummary(summary))
      }
      return list
    },
  }
}

export const reportStorageError = (action: string) => (error: unknown) => {
  // eslint-disable-next-line no-console
  console.error(`[storage] ${action} failed`, error)
}
