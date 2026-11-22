import type { KeyValueStore } from '@deepseek-chat/spine/ports'

/**
 * localStorage as the spine KeyValueStore. When storage is unavailable (private mode, quota),
 * reads return null and writes are dropped: the owning slice keeps the value in memory for the
 * session, as before.
 */
export const localStore: KeyValueStore = {
  get: (key) => {
    try {
      return localStorage.getItem(key)
    } catch {
      return null
    }
  },
  set: (key, value) => {
    try {
      if (value === null) {
        localStorage.removeItem(key)
      } else {
        localStorage.setItem(key, value)
      }
    } catch {
      // 存储不可用时只在内存中生效
    }
  },
}
