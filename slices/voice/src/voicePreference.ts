import type { KeyValueStore } from '@deepseek-chat/spine/ports'
import type { TtsVoice } from './speechApi.js'

/** Storage key kept from the original app so the saved voice survives the upgrade. */
const STORAGE_KEY = 'chat-demo:tts-voice'

/** The read-aloud voice the user picked. Unset or unknown → the service default, stella. */
export const createVoicePreference = (store: KeyValueStore) => {
  let voice: TtsVoice = store.get(STORAGE_KEY) === 'tide' ? 'tide' : 'stella'
  const listeners = new Set<() => void>()

  return {
    get: (): TtsVoice => voice,
    set: (next: TtsVoice) => {
      voice = next
      store.set(STORAGE_KEY, next)
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

export type VoicePreference = ReturnType<typeof createVoicePreference>
