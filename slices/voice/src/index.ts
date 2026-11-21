import type { HttpFetch } from '@deepseek-chat/spine/ports'
import { browserAudio, type VoiceAudio } from './audio.js'
import { createReadAloud, type ReadAloudState } from './readAloud.js'
import { createReadAloudButton } from './ReadAloudButton.js'
import { Spectrum } from './Spectrum.js'
import { createSpeechApi, type TtsVoice } from './speechApi.js'
import { VoiceButton } from './VoiceButton.js'
import { createUseVoiceInput, createVoiceInput, type VoiceInput } from './voiceInput.js'

export type { AudioContextLike, VoiceAudio } from './audio.js'
export type { ReadAloudState } from './readAloud.js'
export type { TtsVoice } from './speechApi.js'
export type { VoiceInput, VoiceInputStatus } from './voiceInput.js'

export type VoiceSliceDeps = {
  readonly fetch: HttpFetch
  /** DeepSeek API origin; speech endpoints live under `/v1/tools`. */
  readonly apiOrigin: string
  /** The user's DeepSeek API key. Read when each request starts. */
  readonly apiKey: () => string | null
  /** The user's read-aloud voice. Read when each read-aloud starts. */
  readonly voice: () => TtsVoice
  /** Audio and microphone; defaults to the browser's. */
  readonly audio?: VoiceAudio
}

export const createVoiceSlice = (deps: VoiceSliceDeps) => {
  const api = createSpeechApi({ fetch: deps.fetch, apiOrigin: deps.apiOrigin })
  const audio = deps.audio ?? browserAudio()
  const readAloud = createReadAloud({ api, audio, apiKey: deps.apiKey, voice: deps.voice })
  const inputDeps = { api, audio, apiKey: deps.apiKey }

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
    ReadAloudButton: createReadAloudButton(readAloud),
    VoiceButton,
    Spectrum,
  }
}

export type VoiceSlice = ReturnType<typeof createVoiceSlice>
