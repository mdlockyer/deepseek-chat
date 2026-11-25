import type { BlobEntry, BlobStore } from '@deepseek-chat/spine/ports'

const DB_VERSION = 1
const BLOBS_STORE = 'blobs'

const request = <T>(req: IDBRequest<T>) =>
  new Promise<T>((resolve, reject) => {
    req.onsuccess = () => resolve(req.result)
    req.onerror = () => reject(req.error)
  })

const transactionDone = (tx: IDBTransaction) =>
  new Promise<void>((resolve, reject) => {
    tx.oncomplete = () => resolve()
    tx.onerror = () => reject(tx.error)
    tx.onabort = () => reject(tx.error ?? new DOMException('Transaction aborted', 'AbortError'))
  })

/**
 * Factory-scoped IndexedDB implementation of the Spine `BlobStore` port.
 * Uses a clean `deepseek-blobs` database with zero module-level handles.
 */
export const createIndexedDbBlobStore = (
  dbName = 'deepseek-blobs'
): BlobStore & { close(): void } => {
  let dbPromise: Promise<IDBDatabase> | null = null

  const openDb = () => {
    dbPromise ??= new Promise<IDBDatabase>((resolve, reject) => {
      const req = indexedDB.open(dbName, DB_VERSION)
      req.onupgradeneeded = () => {
        const db = req.result
        if (!db.objectStoreNames.contains(BLOBS_STORE)) {
          db.createObjectStore(BLOBS_STORE, { keyPath: 'id' })
        }
      }
      req.onsuccess = () => {
        const db = req.result
        db.onclose = () => {
          dbPromise = null
        }
        resolve(db)
      }
      req.onerror = () => {
        dbPromise = null
        reject(req.error)
      }
      req.onblocked = () => {
        dbPromise = null
        reject(new Error('IndexedDB blob store upgrade blocked'))
      }
    })
    return dbPromise
  }

  return {
    get: async (id) => {
      const db = await openDb()
      const tx = db.transaction(BLOBS_STORE, 'readonly')
      const record = await request<{ id: string; blob: Blob } | undefined>(
        tx.objectStore(BLOBS_STORE).get(id)
      )
      return record?.blob
    },

    put: async (entries: readonly BlobEntry[]) => {
      if (entries.length === 0) {
        return
      }
      const db = await openDb()
      const tx = db.transaction(BLOBS_STORE, 'readwrite')
      const store = tx.objectStore(BLOBS_STORE)
      for (const entry of entries) {
        store.put({ id: entry.id, blob: entry.blob })
      }
      await transactionDone(tx)
    },

    delete: async (ids: readonly string[]) => {
      if (ids.length === 0) {
        return
      }
      const db = await openDb()
      const tx = db.transaction(BLOBS_STORE, 'readwrite')
      const store = tx.objectStore(BLOBS_STORE)
      for (const id of ids) {
        store.delete(id)
      }
      await transactionDone(tx)
    },

    clear: async () => {
      const db = await openDb()
      const tx = db.transaction(BLOBS_STORE, 'readwrite')
      tx.objectStore(BLOBS_STORE).clear()
      await transactionDone(tx)
    },

    replaceAll: async (entries: readonly BlobEntry[]) => {
      const db = await openDb()
      const tx = db.transaction(BLOBS_STORE, 'readwrite')
      const store = tx.objectStore(BLOBS_STORE)
      store.clear()
      for (const entry of entries) {
        store.put({ id: entry.id, blob: entry.blob })
      }
      await transactionDone(tx)
    },

    close: () => {
      const pending = dbPromise
      dbPromise = null
      void pending?.then(
        (db) => db.close(),
        () => undefined
      )
    },
  }
}
