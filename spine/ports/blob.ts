/**
 * Domain-blind binary blob storage port owned by Tier 1 (The Spine).
 * Implemented by IndexedDB in the app shell and by `memoryBlobStore()` in tests and demos.
 */

export type BlobEntry = {
  readonly id: string
  readonly blob: Blob
}

export type BlobStore = {
  get(id: string): Promise<Blob | undefined>
  put(entries: readonly BlobEntry[]): Promise<void>
  delete(ids: readonly string[]): Promise<void>
  clear(): Promise<void>
  /** Atomically replaces every stored blob with `entries`. */
  replaceAll(entries: readonly BlobEntry[]): Promise<void>
}

/** In-memory BlobStore for hermetic slice tests and isolated demo runtimes. */
export const memoryBlobStore = (initial: readonly BlobEntry[] = []): BlobStore => {
  const map = new Map<string, Blob>(initial.map((entry) => [entry.id, entry.blob]))
  return {
    get: async (id) => map.get(id),
    put: async (entries) => {
      for (const entry of entries) {
        map.set(entry.id, entry.blob)
      }
    },
    delete: async (ids) => {
      for (const id of ids) {
        map.delete(id)
      }
    },
    clear: async () => {
      map.clear()
    },
    replaceAll: async (entries) => {
      map.clear()
      for (const entry of entries) {
        map.set(entry.id, entry.blob)
      }
    },
  }
}
