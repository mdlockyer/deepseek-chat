import assert from 'node:assert/strict'
import { afterEach, beforeEach, describe, it } from 'node:test'
import { getToast } from '@deepseek-chat/spine/design'
import { setLocale } from '@deepseek-chat/spine/i18n'
import { memoryStore } from '@deepseek-chat/spine/ports'
import {
  createVoiceSlice,
  type AudioContextLike,
  type VoiceAudio,
  type VoiceSliceDeps,
} from '@deepseek-chat/slice-voice'

// ---------- fakes ----------

type Scheduled = { samples: Float32Array; at: number; end: () => void }

/** Minimal Web Audio graph: records scheduled PCM and lets the test end playback. */
class FakeContext {
  readonly sampleRate: number
  currentTime = 0
  state: AudioContextState = 'running'
  closed = false
  readonly destination = {}
  readonly scheduled: Scheduled[] = []
  processor: { onaudioprocess: ((event: unknown) => void) | null } | null = null

  constructor(sampleRate: number) {
    this.sampleRate = sampleRate
  }

  createBuffer(_channels: number, length: number, rate: number) {
    const data = new Float32Array(length)
    return { duration: length / rate, data, copyToChannel: (src: Float32Array) => data.set(src) }
  }

  createBufferSource() {
    const source = {
      buffer: null as { data: Float32Array } | null,
      onended: null as (() => void) | null,
      connect: () => undefined,
      start: (at: number) => {
        this.scheduled.push({
          samples: source.buffer?.data ?? new Float32Array(),
          at,
          end: () => source.onended?.(),
        })
      },
    }
    return source
  }

  createMediaStreamSource() {
    return { connect: () => undefined, disconnect: () => undefined }
  }

  createScriptProcessor() {
    const processor = {
      onaudioprocess: null as ((event: unknown) => void) | null,
      connect: () => undefined,
      disconnect: () => undefined,
    }
    this.processor = processor
    return processor
  }

  createAnalyser() {
    return {
      fftSize: 0,
      smoothingTimeConstant: 0,
      connect: () => undefined,
      disconnect: () => undefined,
    }
  }

  resume() {
    return Promise.resolve()
  }

  close() {
    this.closed = true
    return Promise.resolve()
  }

  /** Delivers one 4096-sample microphone frame of `value`. */
  feed(value: number) {
    const data = new Float32Array(4096).fill(value)
    this.processor?.onaudioprocess?.({ inputBuffer: { getChannelData: () => data } })
  }
}

const createFakeAudio = (options: { secure?: boolean; micError?: unknown } = {}) => {
  const contexts: FakeContext[] = []
  const tracks: { stopped: boolean }[] = []
  let grant: (() => void) | null = null
  let holdGrant = false
  const audio: VoiceAudio = {
    createContext: (rate) => {
      const context = new FakeContext(rate)
      contexts.push(context)
      return context as unknown as AudioContextLike
    },
    getMicrophone: () => {
      if (options.micError) {
        return Promise.reject(options.micError)
      }
      const track = { stopped: false, stop: () => (track.stopped = true) }
      tracks.push(track)
      const stream = { getTracks: () => [track] } as unknown as MediaStream
      if (holdGrant) {
        return new Promise((resolve) => {
          grant = () => resolve(stream)
        })
      }
      return Promise.resolve(stream)
    },
    secureContext: options.secure ?? true,
  }
  return {
    audio,
    contexts,
    tracks,
    holdNextGrant: () => {
      holdGrant = true
    },
    releaseGrant: () => grant?.(),
  }
}

type Call = { url: string; init: RequestInit }

/** A PCM stream whose chunks the test pushes one by one. */
const controllableStream = () => {
  let controller!: ReadableStreamDefaultController<Uint8Array>
  const stream = new ReadableStream<Uint8Array>({
    start: (c) => {
      controller = c
    },
  })
  return {
    stream,
    push: (bytes: number[]) => controller.enqueue(new Uint8Array(bytes)),
    end: () => controller.close(),
  }
}

const setup = (
  respond: (call: Call) => Response | Promise<Response>,
  overrides: Partial<VoiceSliceDeps> & { audioOptions?: Parameters<typeof createFakeAudio>[0] } = {}
) => {
  const calls: Call[] = []
  const fake = createFakeAudio(overrides.audioOptions)
  const voice = createVoiceSlice({
    fetch: async (url, init) => {
      const call = { url, init }
      calls.push(call)
      return respond(call)
    },
    apiOrigin: 'https://api.test',
    apiKey: () => 'sk-test',
    store: memoryStore({ 'chat-demo:tts-voice': 'tide' }),
    audio: fake.audio,
    ...overrides,
  })
  return { voice, calls, fake }
}

const tick = () => new Promise((resolve) => setTimeout(resolve, 0))
const settle = async () => {
  for (let i = 0; i < 10; i += 1) {
    await tick()
  }
}
const toastText = () => getToast().content?.text() ?? null

beforeEach(() => setLocale('en-US'))

// ---------- read-aloud ----------

describe('voice: read-aloud', () => {
  it('requests PCM speech with the current key and voice', async () => {
    const pcm = controllableStream()
    const { voice, calls } = setup(() => new Response(pcm.stream))

    voice.readAloud.toggle('m1', 'Hello **world**', () => undefined)
    await settle()

    assert.equal(calls[0]?.url, 'https://api.test/v1/tools/tts')
    assert.equal(new Headers(calls[0]?.init.headers).get('Authorization'), 'Bearer sk-test')
    assert.deepEqual(JSON.parse(String(calls[0]?.init.body)), {
      text: 'Hello **world**',
      voice_id: 'tide',
      format: 'pcm',
      filter_markdown: true,
    })
  })

  it('goes loading → playing → idle as audio arrives and finishes', async () => {
    const pcm = controllableStream()
    const { voice, fake } = setup(() => new Response(pcm.stream))

    voice.readAloud.toggle('m1', 'text', () => undefined)
    assert.deepEqual(voice.readAloud.getState(), { status: 'loading', messageId: 'm1' })

    pcm.push([0x00, 0x40])
    await settle()
    assert.deepEqual(voice.readAloud.getState(), { status: 'playing', messageId: 'm1' })

    pcm.end()
    await settle()
    assert.equal(voice.readAloud.getState().status, 'playing', 'still playing scheduled audio')

    fake.contexts[0]?.scheduled.at(-1)?.end()
    assert.deepEqual(voice.readAloud.getState(), { status: 'idle' })
    assert.equal(fake.contexts[0]?.closed, true)
  })

  it('returns to idle when the audio finished playing before the stream closed', async () => {
    const pcm = controllableStream()
    const { voice, fake } = setup(() => new Response(pcm.stream))
    voice.readAloud.toggle('m1', 'text', () => undefined)
    pcm.push([0x00, 0x40])
    await settle()
    pcm.push([0x00, 0x20])
    await settle()
    assert.deepEqual(voice.readAloud.getState(), { status: 'playing', messageId: 'm1' })
    // Everything scheduled plays to its end; the server closes the stream only afterwards.
    for (const chunk of fake.contexts[0]?.scheduled ?? []) {
      chunk.end()
    }
    assert.equal(voice.readAloud.getState().status, 'playing', 'the stream may still bring more')
    pcm.end()
    await settle()
    assert.deepEqual(voice.readAloud.getState(), { status: 'idle' })
    assert.equal(fake.contexts[0]?.closed, true)
  })

  it('decodes 16-bit little-endian PCM, carrying an odd byte across chunks', async () => {
    const pcm = controllableStream()
    const { voice, fake } = setup(() => new Response(pcm.stream))

    voice.readAloud.toggle('m1', 'text', () => undefined)
    // Samples: 0x4000 = 16384 → 0.5; 0x7fff = 32767 → 32767/32768. Split after the first byte.
    pcm.push([0x00])
    await settle()
    pcm.push([0x40, 0xff, 0x7f])
    await settle()

    const samples = fake.contexts[0]?.scheduled.flatMap((s) => [...s.samples])
    assert.deepEqual(samples, [...Float32Array.from([0.5, 32767 / 32768])])
    assert.equal(fake.contexts[0]?.sampleRate, 24000)
  })

  it('stops when the reply being read is toggled again, without reporting an error', async () => {
    const pcm = controllableStream()
    const errors: string[] = []
    const { voice, fake } = setup(() => new Response(pcm.stream))

    voice.readAloud.toggle('m1', 'text', (m) => errors.push(m()))
    voice.readAloud.toggle('m1', 'text', (m) => errors.push(m()))
    await settle()

    assert.deepEqual(voice.readAloud.getState(), { status: 'idle' })
    assert.equal(fake.contexts[0]?.closed, true)
    assert.equal(fake.contexts.length, 1, 'no second context')
    assert.deepEqual(errors, [])
  })

  it('switches to another reply, stopping the first', async () => {
    const { voice, fake } = setup(() => new Response(controllableStream().stream))

    voice.readAloud.toggle('m1', 'one', () => undefined)
    voice.readAloud.toggle('m2', 'two', () => undefined)

    assert.deepEqual(voice.readAloud.getState(), { status: 'loading', messageId: 'm2' })
    assert.equal(fake.contexts[0]?.closed, true)
    assert.equal(fake.contexts[1]?.closed, false)
  })

  it('goes straight to idle for a stream with no audio', async () => {
    const pcm = controllableStream()
    const { voice } = setup(() => new Response(pcm.stream))

    voice.readAloud.toggle('m1', 'text', () => undefined)
    pcm.end()
    await settle()

    assert.deepEqual(voice.readAloud.getState(), { status: 'idle' })
  })

  for (const [status, expected] of [
    [400, 'This answer cannot be read aloud right now'],
    [401, 'Invalid API Key. Please change it and try again.'],
    [402, 'Insufficient balance'],
    [429, 'Too many requests. Please try again later.'],
    [500, 'Failed to read aloud. Please try again later.'],
  ] as const) {
    it(`reports HTTP ${status} as "${expected}" and returns to idle`, async () => {
      const errors: string[] = []
      const { voice } = setup(() => new Response('{"error":"x"}', { status }))

      voice.readAloud.toggle('m1', 'text', (m) => errors.push(m()))
      await settle()

      assert.deepEqual(errors, [expected])
      assert.deepEqual(voice.readAloud.getState(), { status: 'idle' })
    })
  }

  it('reports a network failure as the generic failure', async () => {
    const errors: string[] = []
    const voice = setup(() => {
      throw new TypeError('Failed to fetch')
    }).voice

    voice.readAloud.toggle('m1', 'text', (m) => errors.push(m()))
    await settle()

    assert.deepEqual(errors, ['Failed to read aloud. Please try again later.'])
  })

  it('does not report an error for a request stopped before it answered', async () => {
    const errors: string[] = []
    const { voice } = setup(
      (call) =>
        new Promise((_resolve, reject) =>
          call.init.signal?.addEventListener('abort', () =>
            reject(new DOMException('Aborted', 'AbortError'))
          )
        )
    )

    voice.readAloud.toggle('m1', 'text', (m) => errors.push(m()))
    voice.readAloud.stop()
    await settle()

    assert.deepEqual(errors, [])
    assert.deepEqual(voice.readAloud.getState(), { status: 'idle' })
  })
})

// ---------- voice input ----------

const asrOk = (text: string) => () => new Response(JSON.stringify({ text }))

const readWav = async (call: Call | undefined) => {
  assert.ok(call?.init.body instanceof FormData, 'multipart body')
  const file = call.init.body.get('file') as File
  const view = new DataView(await file.arrayBuffer())
  const ascii = (offset: number) =>
    String.fromCharCode(...[0, 1, 2, 3].map((i) => view.getUint8(offset + i)))
  return {
    name: file.name,
    type: file.type,
    riff: ascii(0),
    wave: ascii(8),
    format: view.getUint16(20, true),
    channels: view.getUint16(22, true),
    sampleRate: view.getUint32(24, true),
    bits: view.getUint16(34, true),
    dataBytes: view.getUint32(40, true),
    firstSample: view.getInt16(44, true),
  }
}

describe('voice: voice input', () => {
  afterEach(settle)

  it('does nothing outside a secure context', async () => {
    const { voice, fake } = setup(asrOk('x'), { audioOptions: { secure: false } })
    const input = voice.createVoiceInput(() => undefined)

    await input.toggle()

    assert.equal(input.available, false)
    assert.equal(input.getStatus(), 'idle')
    assert.equal(fake.tracks.length, 0, 'microphone not requested')
  })

  it('records, transcribes a 16 kHz mono WAV, and hands over trimmed text', async () => {
    const texts: string[] = []
    const { voice, calls, fake } = setup(asrOk('  hello there \n'))
    const input = voice.createVoiceInput((text) => texts.push(text))
    const statuses: string[] = []
    input.subscribe(() => statuses.push(input.getStatus()))

    await input.toggle()
    assert.equal(input.getStatus(), 'recording')
    fake.contexts[0]?.feed(0.5)
    fake.contexts[0]?.feed(-1)

    await input.toggle()

    assert.deepEqual(statuses, ['recording', 'transcribing', 'idle'])
    assert.deepEqual(texts, ['hello there'])
    assert.equal(calls[0]?.url, 'https://api.test/v1/tools/asr')
    assert.equal(new Headers(calls[0]?.init.headers).get('Authorization'), 'Bearer sk-test')
    // 2 frames × 4096 samples × 2 bytes = 16384 data bytes; 0.5 → 0.5 × 0x7fff = 16383.
    assert.deepEqual(await readWav(calls[0]), {
      name: 'recording.wav',
      type: 'audio/wav',
      riff: 'RIFF',
      wave: 'WAVE',
      format: 1,
      channels: 1,
      sampleRate: 16000,
      bits: 16,
      dataBytes: 16384,
      firstSample: 16383,
    })
    assert.equal(fake.tracks[0]?.stopped, true, 'microphone released')
  })

  it('says no speech was detected for a blank transcript', async () => {
    const texts: string[] = []
    const { voice, fake } = setup(asrOk('   '))
    const input = voice.createVoiceInput((text) => texts.push(text))

    await input.toggle()
    fake.contexts[0]?.feed(0.1)
    await input.toggle()

    assert.deepEqual(texts, [])
    assert.equal(toastText(), 'No speech detected')
  })

  it('reports a failed transcription', async () => {
    const { voice, fake } = setup(() => new Response('busy', { status: 503 }))
    const input = voice.createVoiceInput(() => undefined)

    await input.toggle()
    fake.contexts[0]?.feed(0.1)
    await input.toggle()

    assert.equal(input.getStatus(), 'idle')
    assert.equal(toastText(), 'Speech recognition failed. Please try again later.')
  })

  it('sends nothing when nothing was recorded', async () => {
    const { voice, calls } = setup(asrOk('x'))
    const input = voice.createVoiceInput(() => undefined)

    await input.toggle()
    await input.toggle()

    assert.equal(calls.length, 0)
    assert.equal(input.getStatus(), 'idle')
  })

  it('cancels a transcription in flight and ignores its late result', async () => {
    const texts: string[] = []
    let answer: (response: Response) => void = () => undefined
    let seenSignal: AbortSignal | undefined
    const { voice, fake } = setup((call) => {
      seenSignal = call.init.signal ?? undefined
      return new Promise((resolve) => {
        answer = resolve
      })
    })
    const input = voice.createVoiceInput((text) => texts.push(text))
    await input.toggle()
    fake.contexts[0]?.feed(0.1)
    const finishing = input.toggle()
    await settle()
    const toastBefore = getToast().id

    await input.toggle()
    assert.equal(input.getStatus(), 'idle')
    assert.equal(seenSignal?.aborted, true)

    answer(new Response(JSON.stringify({ text: 'too late' })))
    await finishing
    assert.deepEqual(texts, [])
    assert.equal(getToast().id, toastBefore, 'no toast for a cancelled transcription')
    assert.equal(input.getStatus(), 'idle')
  })

  it('releases a microphone granted after the user cancelled', async () => {
    const { voice, fake } = setup(asrOk('x'))
    fake.holdNextGrant()
    const input = voice.createVoiceInput(() => undefined)

    const starting = input.toggle()
    input.cancel()
    fake.releaseGrant()
    await starting

    assert.equal(input.getStatus(), 'idle')
    assert.equal(fake.tracks[0]?.stopped, true)
  })

  for (const [name, expected] of [
    ['NotAllowedError', 'Microphone access is blocked. Please allow it in your browser settings.'],
    ['SecurityError', 'Microphone access is blocked. Please allow it in your browser settings.'],
    ['NotFoundError', 'No microphone detected'],
    ['AbortError', 'Speech recognition failed. Please try again later.'],
  ] as const) {
    it(`explains a microphone ${name}`, async () => {
      const { voice } = setup(asrOk('x'), {
        audioOptions: { micError: new DOMException('denied', name) },
      })
      const input = voice.createVoiceInput(() => undefined)

      await input.toggle()

      assert.equal(input.getStatus(), 'idle')
      assert.equal(toastText(), expected)
    })
  }

  it('stops at the length limit, says so, and sends at most 120 s of audio', async () => {
    const texts: string[] = []
    const { voice, calls, fake } = setup(asrOk('long'))
    const input = voice.createVoiceInput((text) => texts.push(text))
    await input.toggle()

    // 120 s × 16000 = 1,920,000 samples; 4096 per frame → the 469th frame crosses the limit.
    for (let frame = 0; frame < 470; frame += 1) {
      fake.contexts[0]?.feed(0.1)
    }
    assert.equal(toastText(), 'Maximum recording length reached')
    await settle()

    assert.deepEqual(texts, ['long'])
    assert.equal(calls.length, 1)
    assert.equal((await readWav(calls[0])).dataBytes, 1_920_000 * 2)
  })
})

// ---------- read-aloud voice preference ----------

describe('voice: read-aloud voice preference', () => {
  const voiceSent = async (voice: ReturnType<typeof setup>['voice'], calls: Call[]) => {
    voice.readAloud.toggle(`m${calls.length}`, 'text', () => undefined)
    await settle()
    voice.readAloud.stop()
    return JSON.parse(String(calls.at(-1)?.init.body)).voice_id
  }

  it('defaults to stella when nothing or an unknown voice is stored', () => {
    // SPEC: unset or unknown → the service default, stella.
    assert.equal(
      setup(() => new Response(null), { store: memoryStore() }).voice.getTtsVoice(),
      'stella'
    )
    const odd = memoryStore({ 'chat-demo:tts-voice': 'ocean' })
    assert.equal(setup(() => new Response(null), { store: odd }).voice.getTtsVoice(), 'stella')
  })

  it('reads the saved voice from the original storage key', async () => {
    const { voice, calls } = setup(() => new Response(controllableStream().stream))
    assert.equal(voice.getTtsVoice(), 'tide')
    assert.equal(await voiceSent(voice, calls), 'tide')
  })

  it('saves a new voice, which the next read-aloud uses', async () => {
    const store = memoryStore()
    const { voice, calls } = setup(() => new Response(controllableStream().stream), { store })

    assert.equal(await voiceSent(voice, calls), 'stella')
    voice.setTtsVoice('tide')

    assert.equal(store.get('chat-demo:tts-voice'), 'tide')
    assert.equal(await voiceSent(voice, calls), 'tide')
  })
})
