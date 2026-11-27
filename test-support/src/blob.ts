import type { BlobEntry, BlobStore } from '@deepseek-chat/spine/ports'

/** In-memory BlobStore fake for hermetic slice tests and offline workbenches. */
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
