import type { HttpFetch } from '@deepseek-chat/spine/ports'

/**
 * 语音接口：
 * - ASR：POST /v1/tools/asr，multipart 上传 WAV / Ogg Opus，一次返回全文
 * - TTS：POST /v1/tools/tts，返回音频字节流（产出首帧后即返回 200）
 * 鉴权都用 Authorization: Bearer。
 */

export type TtsVoice = 'stella' | 'tide'

/** TTS 输出的裸 PCM 参数：24kHz、单声道、16-bit 小端 */
export const TTS_SAMPLE_RATE = 24000

/** Why a speech request failed. Callers word each case for their own context. */
export type SpeechFailure =
  /** Non-2xx response. */
  | { kind: 'http'; status: number; message: string }
  /** The request never reached the server. */
  | { kind: 'network'; message: string }
  /** The response did not match the protocol. */
  | { kind: 'protocol'; message: string }

export class SpeechApiError extends Error {
  readonly failure: SpeechFailure

  constructor(failure: SpeechFailure) {
    super(failure.message)
    this.name = 'SpeechApiError'
    this.failure = failure
  }
}

const extractErrorMessage = (text: string): string | null => {
  let body: unknown
  try {
    body = JSON.parse(text)
  } catch {
    return null
  }
  if (typeof body !== 'object' || body === null || !('error' in body)) {
    return null
  }
  const { error } = body as { error?: unknown }
  if (typeof error === 'string') {
    return error
  }
  if (typeof error === 'object' && error !== null && 'message' in error) {
    const { message } = error as { message?: unknown }
    return typeof message === 'string' ? message : null
  }
  return null
}

export const createSpeechApi = ({ fetch, apiOrigin }: { fetch: HttpFetch; apiOrigin: string }) => {
  const toolsBaseUrl = `${apiOrigin}/v1/tools`

  /** Resolves only for 2xx. A caller abort propagates unchanged. */
  const request = async (url: string, init: RequestInit): Promise<Response> => {
    let response: Response
    try {
      response = await fetch(url, init)
    } catch (error) {
      if (init.signal?.aborted) {
        throw error
      }
      throw new SpeechApiError({
        kind: 'network',
        message: error instanceof Error ? error.message : String(error),
      })
    }
    if (!response.ok) {
      const text = await response.text().catch(() => '')
      throw new SpeechApiError({
        kind: 'http',
        status: response.status,
        message: extractErrorMessage(text) ?? (text || response.statusText),
      })
    }
    return response
  }

  /** 语音识别：audio 为 WAV（单声道 16-bit PCM）或 Ogg Opus，时长不超过 120 秒、大小不超过 8 MiB */
  const transcribe = async (apiKey: string, audio: Blob, signal?: AbortSignal): Promise<string> => {
    const form = new FormData()
    form.append('file', audio, 'recording.wav')
    const response = await request(`${toolsBaseUrl}/asr`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${apiKey}` },
      body: form,
      ...(signal ? { signal } : {}),
    })
    const raw = await response.text()
    let body: unknown
    try {
      body = JSON.parse(raw)
    } catch {
      throw new SpeechApiError({ kind: 'protocol', message: raw })
    }
    if (
      typeof body !== 'object' ||
      body === null ||
      !('text' in body) ||
      typeof body.text !== 'string'
    ) {
      throw new SpeechApiError({ kind: 'protocol', message: raw })
    }
    return body.text
  }

  /** 语音合成：返回裸 PCM 字节流；服务端默认过滤代码块、表格、引用标记与长公式 */
  const synthesize = async (
    apiKey: string,
    text: string,
    voice: TtsVoice,
    signal: AbortSignal
  ): Promise<ReadableStream<Uint8Array>> => {
    const response = await request(`${toolsBaseUrl}/tts`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${apiKey}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ text, voice_id: voice, format: 'pcm', filter_markdown: true }),
      signal,
    })
    if (!response.body) {
      throw new SpeechApiError({ kind: 'protocol', message: await response.text() })
    }
    return response.body
  }

  return { transcribe, synthesize }
}

export type SpeechApi = ReturnType<typeof createSpeechApi>
