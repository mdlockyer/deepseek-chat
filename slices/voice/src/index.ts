import type {
  ActiveSessionChanged,
  ReplyLifecycleChanged,
} from '@deepseek-chat/spine/facts/session'
import {
  noopNoticePort,
  type HttpFetch,
  type KeyValueStore,
  type NoticePort,
} from '@deepseek-chat/spine/ports'
import type { EventLog } from '@deepseek-chat/spine/runtime'
import { browserAudio, type VoiceAudio } from './audio.js'
import { createReadAloud, type ReadAloudState } from './readAloud.js'
import { createReadAloudButton } from './ReadAloudButton.js'
import { Spectrum } from './Spectrum.js'
import { createSpeechApi, type TtsVoice } from './speechApi.js'
import { VoiceButton } from './VoiceButton.js'
import { createUseVoiceInput, createVoiceInput, type VoiceInput } from './voiceInput.js'
import { createVoicePreference } from './voicePreference.js'
import { createVoiceSetting } from './VoiceSetting.js'

export type { AudioContextLike, VoiceAudio } from './audio.js'
export type { ReadAloudState } from './readAloud.js'
export type { TtsVoice } from './speechApi.js'
export type { VoiceInputStatus } from './voiceInput.js'

export type VoiceSliceDeps = {
  readonly log: EventLog
  readonly fetch: HttpFetch
  /** DeepSeek API origin; speech endpoints live under `/v1/tools`. */
  readonly apiOrigin: string
  /** The user's DeepSeek API key. Read when each request starts. */
  readonly apiKey: () => string | null
  /** Persists the user's read-aloud voice (`chat-demo:tts-voice`). */
  readonly store: KeyValueStore
  /** Audio and microphone; defaults to the browser's. */
  readonly audio?: VoiceAudio
  /** Ephemeral user feedback port; defaults to a safe no-op for headless callers. */
  readonly notify?: NoticePort
}

export const createVoiceSlice = (deps: VoiceSliceDeps) => {
  const api = createSpeechApi({ fetch: deps.fetch, apiOrigin: deps.apiOrigin })
  const audio = deps.audio ?? browserAudio()
  const notify = deps.notify ?? noopNoticePort
  const preference = createVoicePreference(deps.store)
  const readAloud = createReadAloud({ api, audio, apiKey: deps.apiKey, voice: preference.get })
  const inputDeps = { api, audio, apiKey: deps.apiKey, notify }

  let lastActiveSession: string | null | undefined
  const unsubscribers = [
    deps.log.subscribe<ActiveSessionChanged>('ActiveSessionChanged', ({ fact }) => {
      if (lastActiveSession !== undefined && fact.sessionId !== lastActiveSession) {
        readAloud.stop()
      }
      lastActiveSession = fact.sessionId
    }),
    deps.log.subscribe<ReplyLifecycleChanged>('ReplyLifecycleChanged', ({ fact }) => {
      if (fact.phase === 'started') {
        readAloud.stop()
      }
    }),
  ]

  return {
    /** Read-aloud: one reply at a time. */
    readAloud: {
      /** Start reading `messageId`, or stop if it is already being read. Call from a click. */
      toggle: readAloud.toggle,
      stop: readAloud.stop,
      getState: (): ReadAloudState => readAloud.getState(),
      subscribe: readAloud.subscribe,
    },
    /** Voice input controller, one per composer. */
    createVoiceInput: (onText: (text: string) => void): VoiceInput =>
      createVoiceInput(inputDeps, onText),
    /** React binding of `createVoiceInput`, released on unmount. */
    useVoiceInput: createUseVoiceInput(inputDeps),
    /** The read-aloud voice; a change applies from the next read-aloud. */
    getTtsVoice: (): TtsVoice => preference.get(),
    setTtsVoice: (voice: TtsVoice) => preference.set(voice),
    /** Settings row for the read-aloud voice. */
    VoiceSetting: createVoiceSetting(preference),
    ReadAloudButton: createReadAloudButton(readAloud, notify),
    VoiceButton,
    Spectrum,
    dispose: () => {
      readAloud.stop()
      for (const unsubscribe of unsubscribers) {
        unsubscribe()
      }
    },
  }
}

export type VoiceSlice = ReturnType<typeof createVoiceSlice>
