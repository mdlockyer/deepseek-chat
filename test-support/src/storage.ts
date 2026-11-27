import type { KeyValueStore } from '@deepseek-chat/spine/ports'

/** In-memory KeyValueStore fake for offline slice tests and dev workbenches. */
export const memoryStore = (initial: Record<string, string> = {}): KeyValueStore => {
  const values = new Map(Object.entries(initial))
  return {
    get: (key) => values.get(key) ?? null,
    set: (key, value) => {
      if (value === null) {
        values.delete(key)
      } else {
        values.set(key, value)
      }
    },
  }
}
