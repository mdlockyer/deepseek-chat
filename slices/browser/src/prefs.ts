import type { KeyValueStore } from '@deepseek-chat/spine/ports'

/** Storage key kept from the original app so the saved choice survives the upgrade. */
const ALLOW_LOCALHOST_KEY = 'chat-demo:browser-allow-localhost'

/** Whether the model may navigate the built-in browser to localhost / private addresses. */
export const createLocalhostPreference = (store: KeyValueStore) => {
  let allow = store.get(ALLOW_LOCALHOST_KEY) === 'true'
  const listeners = new Set<() => void>()
  return {
    get: () => allow,
    set: (next: boolean) => {
      allow = next
      store.set(ALLOW_LOCALHOST_KEY, String(next))
      for (const listener of [...listeners]) {
        listener()
      }
    },
    subscribe: (listener: () => void) => {
      listeners.add(listener)
      return () => {
        listeners.delete(listener)
      }
    },
  }
}

export type LocalhostPreference = ReturnType<typeof createLocalhostPreference>
