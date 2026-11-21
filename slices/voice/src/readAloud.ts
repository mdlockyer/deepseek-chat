import type { AudioContextLike, VoiceAudio } from './audio.js'
import { voiceMessages } from './messages.js'
import { SpeechApiError, TTS_SAMPLE_RATE, type SpeechApi, type TtsVoice } from './speechApi.js'

/**
 * 朗读：同一时间只读一条回复。
 * 请求 TTS 的裸 PCM 流，边收边用 AudioContext 按顺序排程播放，首帧到达即出声。
 * 状态：loading（已请求、未出声）→ playing → 结束回到 idle。
 */
export type ReadAloudState =
  | { readonly status: 'idle' }
  | { readonly status: 'loading' | 'playing'; readonly messageId: string }

/** 首帧前多缓冲一点，减少网络抖动造成的断续 */
const START_DELAY = 0.1

/** 16-bit 小端 PCM 转成 Float32；奇数字节留到下一段 */
const toFloat32 = (bytes: Uint8Array) => {
  const samples = new Float32Array(bytes.length >> 1)
  const view = new DataView(bytes.buffer, bytes.byteOffset, samples.length * 2)
  for (let i = 0; i < samples.length; i++) {
    samples[i] = view.getInt16(i * 2, true) / 0x8000
  }
  return samples
}

/** Text for a failed read-aloud, rendered lazily in the current locale. */
const describeReadAloudError = (error: unknown): (() => string) => {
  const t = voiceMessages.translate
  if (!(error instanceof SpeechApiError)) {
    return () => t('ttsFailed')
  }
  const { failure } = error
  if (failure.kind === 'protocol') {
    return () => failure.message
  }
  if (failure.kind === 'http') {
    switch (failure.status) {
      // 400 表示这段正文服务端无法合成，与其余失败区分开
      case 400:
        return () => t('ttsUnavailable')
      case 401:
        return () => t('apiKeyInvalidRetry')
      case 402:
        return () => t('insufficientBalance')
      case 429:
        return () => t('rateLimited')
    }
  }
  return () => t('ttsFailed')
}

export const createReadAloud = (deps: {
  api: SpeechApi
  audio: VoiceAudio
  apiKey: () => string | null
  voice: () => TtsVoice
}) => {
  let state: ReadAloudState = { status: 'idle' }
  let current: { controller: AbortController; context: AudioContextLike } | null = null
  const listeners = new Set<() => void>()

  const setState = (next: ReadAloudState) => {
    state = next
    for (const listener of [...listeners]) {
      listener()
    }
  }

  const finish = (controller: AbortController) => {
    if (current?.controller !== controller) {
      return
    }
    void current.context.close()
    current = null
    setState({ status: 'idle' })
  }

  /** 停止当前朗读（发送、停止生成、切换会话等场景调用） */
  const stop = () => {
    if (current) {
      const { controller } = current
      controller.abort()
      finish(controller)
    }
  }

  /**
   * 开始朗读一条回复的正文；同一条正在朗读时调用等于停止。
   * 必须在点击事件中同步调用：AudioContext 需要用户手势才能出声。
   */
  const toggle = (messageId: string, text: string, onError: (message: () => string) => void) => {
    const reading = state.status === 'idle' ? null : state.messageId
    stop()
    if (reading === messageId) {
      return
    }
    const controller = new AbortController()
    const context = deps.audio.createContext(TTS_SAMPLE_RATE)
    current = { controller, context }
    setState({ status: 'loading', messageId })
    // 音色在开始朗读时读取，设置中切换后下一次朗读生效
    const apiKey = deps.apiKey()
    const voice = deps.voice()

    void (async () => {
      let nextTime = 0
      let lastSource: AudioBufferSourceNode | null = null
      let rest = new Uint8Array(0)
      try {
        const stream = await deps.api.synthesize(apiKey ?? '', text, voice, controller.signal)
        const reader = stream.getReader()
        controller.signal.addEventListener('abort', () => void reader.cancel().catch(() => {}))
        for (;;) {
          const { done, value } = await reader.read()
          if (done) {
            break
          }
          const bytes = new Uint8Array(rest.length + value.length)
          bytes.set(rest)
          bytes.set(value, rest.length)
          const samples = toFloat32(bytes)
          rest = bytes.slice(samples.length * 2)
          if (samples.length === 0) {
            continue
          }
          const buffer = context.createBuffer(1, samples.length, TTS_SAMPLE_RATE)
          buffer.copyToChannel(samples, 0)
          const source = context.createBufferSource()
          source.buffer = buffer
          source.connect(context.destination)
          // 网络慢于播放时从当前时间续上，不补播过去的时间
          nextTime = Math.max(nextTime, context.currentTime + (lastSource ? 0 : START_DELAY))
          source.start(nextTime)
          nextTime += buffer.duration
          lastSource = source
          if (state.status === 'loading' && current?.controller === controller) {
            setState({ status: 'playing', messageId })
          }
        }
        if (lastSource) {
          lastSource.onended = () => finish(controller)
        } else {
          finish(controller)
        }
      } catch (error) {
        if (!controller.signal.aborted) {
          finish(controller)
          onError(describeReadAloudError(error))
        }
      }
    })()
  }

  return {
    toggle,
    stop,
    getState: () => state,
    subscribe: (listener: () => void) => {
      listeners.add(listener)
      return () => {
        listeners.delete(listener)
      }
    },
  }
}

export type ReadAloud = ReturnType<typeof createReadAloud>
