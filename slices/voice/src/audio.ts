/** Browser audio and microphone, injected so the slice runs against fakes in tests. */

export type AudioContextLike = Pick<
  AudioContext,
  | 'createBuffer'
  | 'createBufferSource'
  | 'createMediaStreamSource'
  | 'createScriptProcessor'
  | 'createAnalyser'
  | 'destination'
  | 'currentTime'
  | 'state'
  | 'resume'
  | 'close'
>

export type VoiceAudio = {
  /** A new AudioContext at the given sample rate. Must be called from a user gesture to play. */
  createContext(sampleRate: number): AudioContextLike
  /** Mono microphone stream with echo cancellation and noise suppression. */
  getMicrophone(): Promise<MediaStream>
  /** Recording needs a secure context (HTTPS, localhost, file://). */
  readonly secureContext: boolean
}

export const browserAudio = (): VoiceAudio => ({
  createContext: (sampleRate) => new AudioContext({ sampleRate }),
  getMicrophone: () =>
    navigator.mediaDevices.getUserMedia({
      audio: { channelCount: 1, echoCancellation: true, noiseSuppression: true },
    }),
  secureContext: typeof window === 'undefined' || window.isSecureContext,
})
