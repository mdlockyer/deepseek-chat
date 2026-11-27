import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import type {
  SessionDeleted,
  SessionFilesChanged,
  SessionHistoryReplaced,
} from '@deepseek-chat/spine/facts/session'
import { memoryBlobStore, memoryStore } from '@deepseek-chat/test-support'
import { EventLog } from '@deepseek-chat/spine/runtime'
import {
  createPythonSlice,
  type NativePythonHost,
  type NativeRunResponse,
  type PythonPhase,
  type PythonSliceDeps,
} from '@deepseek-chat/slice-python'

const RESTART_NOTICE_TAG = '<python_kernel_reset>'

const response = (overrides: Partial<NativeRunResponse> = {}): NativeRunResponse => ({
  stdout: '',
  result: null,
  error: null,
  interrupted: false,
  restarted: false,
  images: [],
  dropped: 0,
  files: [],
  ...overrides,
})

type Deferred<T> = { promise: Promise<T>; resolve: (value: T) => void }
const deferred = <T>(): Deferred<T> => {
  let resolve: (value: T) => void = () => undefined
  const promise = new Promise<T>((r) => {
    resolve = r
  })
  return { promise, resolve }
}

/** In-memory stand-in for the Rust sandbox: scripted replies, recorded calls. */
const createFakeHost = () => {
  const log: string[] = []
  const runs: { code: string; sessionId: string | undefined }[] = []
  const staged: string[] = []
  let phaseHandler: ((phase: PythonPhase) => void) | null = null
  let reply: (code: string) => Promise<NativeRunResponse> = async () => response()

  const host: NativePythonHost = {
    run: (code, sessionId) => {
      runs.push({ code, sessionId })
      log.push(`run:${code}`)
      return reply(code)
    },
    interrupt: async () => {
      log.push('interrupt')
    },
    reset: async () => {
      log.push('reset')
    },
    stageUpload: async (sessionId, fileId) => {
      staged.push(`${sessionId}:${fileId}`)
    },
    onPhase: (handler) => {
      phaseHandler = handler
      return () => {
        phaseHandler = null
      }
    },
    runtimeStatus: async () => ({ ready: true, version: '3.12', venvPython: null, packages: [] }),
    resetRuntime: async () => {
      log.push('resetRuntime')
    },
  }
  return {
    host,
    log,
    runs,
    staged,
    emitPhase: (phase: PythonPhase) => phaseHandler?.(phase),
    setReply: (next: (code: string) => Promise<NativeRunResponse>) => {
      reply = next
    },
  }
}

const setup = (overrides: Partial<PythonSliceDeps> = {}) => {
  const fake = createFakeHost()
  const events = new EventLog()
  const python = createPythonSlice({
    log: events,
    native: fake.host,
    pyodideIndexURL: 'unused://',
    store: memoryStore(),
    now: () => 0,
    ...overrides,
  })
  return { fake, events, python }
}

const run = (python: ReturnType<typeof setup>['python'], code: string, sessionId = 's1') =>
  python.run(code, { signal: new AbortController().signal, sessionId })

describe('python slice: scheduling', () => {
  it('resolves aborted without reaching the engine when the signal is already aborted', async () => {
    const { fake, python } = setup()
    const controller = new AbortController()
    controller.abort()

    const result = await python.run('1', { signal: controller.signal, sessionId: 's1' })

    assert.equal(result.status, 'aborted')
    assert.equal(result.durationMs, 0)
    assert.deepEqual(fake.runs, [])
  })

  it('runs one call at a time, in call order', async () => {
    const { fake, python } = setup()
    const first = deferred<NativeRunResponse>()
    fake.setReply((code) => (code === 'first' ? first.promise : Promise.resolve(response())))

    const a = run(python, 'first')
    const b = run(python, 'second')
    await new Promise((resolve) => setTimeout(resolve, 0))
    assert.deepEqual(
      fake.runs.map((r) => r.code),
      ['first'],
      'second must wait for first'
    )

    first.resolve(response({ stdout: 'done' }))
    await Promise.all([a, b])
    assert.deepEqual(
      fake.runs.map((r) => r.code),
      ['first', 'second']
    )
  })

  it('resolves a run aborted while queued as aborted, without reaching the engine', async () => {
    const { fake, python } = setup()
    const first = deferred<NativeRunResponse>()
    fake.setReply(() => first.promise)

    const a = run(python, 'first')
    const controller = new AbortController()
    const b = python.run('queued', { signal: controller.signal, sessionId: 's1' })
    controller.abort()

    const queued = await b
    assert.equal(queued.status, 'aborted')
    first.resolve(response())
    await a
    assert.deepEqual(
      fake.runs.map((r) => r.code),
      ['first']
    )
  })

  it('forwards engine phases after announcing starting', async () => {
    const { fake, python } = setup()
    const phases: PythonPhase[] = []
    fake.setReply(async () => {
      fake.emitPhase('installing')
      fake.emitPhase('running')
      return response()
    })

    await python.run('1', { signal: new AbortController().signal, onPhase: (p) => phases.push(p) })

    assert.deepEqual(phases, ['starting', 'installing', 'running'])
  })
})

describe('python slice: output to the model', () => {
  it('joins stdout (minus its final newline), the trailing repr, and the error', async () => {
    const { fake, python } = setup()
    fake.setReply(async () => response({ stdout: 'line\n', result: '42', error: 'ValueError: x' }))

    const result = await run(python, 'x')

    assert.equal(result.text, 'line\n42\nValueError: x')
    assert.equal(result.status, 'error')
  })

  it('reports (no output) when there is nothing to show', async () => {
    const { python } = setup()
    const result = await run(python, 'pass')
    assert.equal(result.text, '(no output)')
    assert.equal(result.status, 'ok')
  })

  it('truncates text beyond outputLimit and says how much was cut', async () => {
    const { fake, python } = setup({ params: { outputLimit: 10 } })
    fake.setReply(async () => response({ stdout: 'x'.repeat(25) }))

    const result = await run(python, 'x')

    // 25 characters, limit 10 => 15 cut.
    assert.equal(result.text, `${'x'.repeat(10)}\n… [output truncated: 15 more characters]`)
  })

  it('keeps text of exactly outputLimit characters and cuts one more', async () => {
    const { fake, python } = setup({ params: { outputLimit: 10 } })
    fake.setReply(async (code) => response({ stdout: 'y'.repeat(Number(code)) }))

    const atLimit = await run(python, '10')
    const overLimit = await run(python, '11')

    assert.equal(atLimit.text, 'y'.repeat(10))
    assert.equal(overLimit.text, `${'y'.repeat(10)}\n… [output truncated: 1 more characters]`)
  })

  it('decodes presented files to bytes and notes them for the model', async () => {
    const { fake, python } = setup()
    // "aGk=" is base64 for "hi" (bytes 104, 105).
    fake.setReply(async () =>
      response({ files: [{ name: 'out.txt', mimeType: 'text/plain', dataBase64: 'aGk=' }] })
    )

    const result = await run(python, 'present_file("out.txt")')

    assert.equal(result.files.length, 1)
    assert.equal(result.files[0]?.name, 'out.txt')
    assert.deepEqual([...(result.files[0]?.data ?? [])], [104, 105])
    assert.equal(result.text, '(no output)\n[Offered to the user for download: out.txt (2 B)]')
  })

  it('notes attached and dropped images', async () => {
    const { fake, python } = setup()
    fake.setReply(async () => response({ images: ['data:a', 'data:b'], dropped: 1 }))

    const result = await run(python, 'plot')

    assert.deepEqual(result.images, ['data:a', 'data:b'])
    assert.equal(
      result.text,
      '(no output)\n[2 images attached below]\n[1 more image not attached: at most 6 per call]'
    )
  })
})

describe('python slice: restart notice', () => {
  it('prefixes the notice once, on the result after the kernel restarted', async () => {
    const { fake, python } = setup()
    fake.setReply(async (code) =>
      code === 'crash' ? response({ restarted: true, error: 'kernel died' }) : response()
    )

    const crashed = await run(python, 'crash')
    const next = await run(python, 'after')
    const later = await run(python, 'later')

    assert.equal(crashed.status, 'error')
    assert.ok(next.text.startsWith(RESTART_NOTICE_TAG), next.text)
    assert.ok(!later.text.includes(RESTART_NOTICE_TAG), later.text)
  })

  it('drops a pending notice when another session takes the kernel', async () => {
    const { fake, python } = setup()
    fake.setReply(async (code) => (code === 'crash' ? response({ restarted: true }) : response()))

    await run(python, 'crash', 's1')
    const other = await run(python, 'fresh', 's2')

    assert.ok(!other.text.includes(RESTART_NOTICE_TAG), other.text)
  })

  it('prefixes the notice once on the web engine after a worker crash or timeout', async () => {
    let spawned = 0
    const makeWebPython = (mode: 'crash' | 'timeout') => {
      spawned = 0
      return createPythonSlice({
        log: new EventLog(),
        native: null,
        pyodideIndexURL: 'unused://',
        store: memoryStore(),
        now: () => 0,
        params: { runTimeoutMs: 15, startupTimeoutMs: 15 },
        spawnWorker: () => {
          const idx = spawned++
          const listeners = {
            message: new Set<(ev: MessageEvent) => void>(),
            error: new Set<(ev: ErrorEvent) => void>(),
          }
          return {
            postMessage: (msg: unknown) => {
              const data = msg as { type?: string; id?: number }
              if (data.type === 'init') {
                return
              }
              if (idx === 0) {
                if (mode === 'crash') {
                  queueMicrotask(() => {
                    for (const fn of listeners.error) {
                      fn({ message: 'worker crashed' } as ErrorEvent)
                    }
                  })
                } else {
                  queueMicrotask(() => {
                    for (const fn of listeners.message) {
                      fn({ data: { id: data.id, phase: 'running' } } as MessageEvent)
                    }
                  })
                }
                return
              }
              queueMicrotask(() => {
                for (const fn of listeners.message) {
                  fn({ data: { id: data.id, phase: 'running' } } as MessageEvent)
                }
                for (const fn of listeners.message) {
                  fn({
                    data: {
                      id: data.id,
                      ok: true,
                      stdout: 'recovered\n',
                      result: null,
                      error: null,
                      images: [],
                      dropped: 0,
                      files: [],
                    },
                  } as MessageEvent)
                }
              })
            },
            terminate: () => {},
            addEventListener: (type: string, fn: EventListenerOrEventListenerObject) => {
              if (type === 'message') {
                listeners.message.add(fn as (ev: MessageEvent) => void)
              } else if (type === 'error') {
                listeners.error.add(fn as (ev: ErrorEvent) => void)
              }
            },
            removeEventListener: (type: string, fn: EventListenerOrEventListenerObject) => {
              if (type === 'message') {
                listeners.message.delete(fn as (ev: MessageEvent) => void)
              } else if (type === 'error') {
                listeners.error.delete(fn as (ev: ErrorEvent) => void)
              }
            },
          }
        },
      })
    }

    for (const mode of ['crash', 'timeout'] as const) {
      const web = makeWebPython(mode)
      const failed = await run(web, 'bad')
      const next = await run(web, 'after')
      const later = await run(web, 'later')

      assert.equal(failed.status, 'error')
      assert.ok(next.text.startsWith(RESTART_NOTICE_TAG), `${mode}: ${next.text}`)
      assert.ok(!later.text.includes(RESTART_NOTICE_TAG), `${mode}: ${later.text}`)
    }
  })
})

describe('python slice: uploads', () => {
  const upload = (id: string) => ({
    id,
    name: `${id}.csv`,
    loadBlob: async () => new Blob(['a,b']),
  })

  it('stages each upload once per session', async () => {
    const { fake, python } = setup()
    const signal = new AbortController().signal

    await python.run('1', { signal, sessionId: 's1', uploads: [upload('f1')] })
    await python.run('2', { signal, sessionId: 's1', uploads: [upload('f1'), upload('f2')] })

    assert.deepEqual(fake.staged, ['s1:f1', 's1:f2'])
  })

  it('stages again for a different session', async () => {
    const { fake, python } = setup()
    const signal = new AbortController().signal

    await python.run('1', { signal, sessionId: 's1', uploads: [upload('f1')] })
    await python.run('2', { signal, sessionId: 's2', uploads: [upload('f1')] })

    assert.deepEqual(fake.staged, ['s1:f1', 's2:f1'])
  })
})

describe('python slice: session lifecycle facts', () => {
  it('silently resets the kernel when its owning session is deleted', async () => {
    const { fake, events, python } = setup()
    await run(python, 'x = 1', 's1')

    events.publish<SessionDeleted>({ type: 'SessionDeleted', sessionId: 's1' })
    const next = await run(python, 'x', 's1')

    assert.ok(fake.log.includes('reset'))
    assert.ok(!next.text.includes(RESTART_NOTICE_TAG), 'owner is gone; no notice')
  })

  it('leaves the kernel alone when another session is deleted', async () => {
    const { fake, events, python } = setup()
    await run(python, 'x = 1', 's1')

    events.publish<SessionDeleted>({ type: 'SessionDeleted', sessionId: 's2' })

    assert.ok(!fake.log.includes('reset'))
  })

  it('resets the kernel when the session history is replaced', async () => {
    const { fake, events, python } = setup()
    await run(python, 'x = 1', 's1')

    events.publish<SessionHistoryReplaced>({ type: 'SessionHistoryReplaced' })

    assert.ok(fake.log.includes('reset'))
  })

  it('stops reacting after dispose', async () => {
    const { fake, events, python } = setup()
    await run(python, 'x = 1', 's1')
    python.dispose()

    events.publish<SessionHistoryReplaced>({ type: 'SessionHistoryReplaced' })

    assert.ok(!fake.log.includes('reset'))
  })
})

describe('python slice: managed runtime and tool', () => {
  it('reinstalls the runtime, then resets the kernel', async () => {
    const { fake, python } = setup()
    assert.ok(python.runtime)

    await python.runtime.reset()

    assert.deepEqual(fake.log, ['resetRuntime', 'reset'])
  })

  it('has no managed runtime on the web engine', () => {
    const { python } = setup({ native: null })
    assert.equal(python.runtime, null)
  })

  it('describes the engine the tool actually runs on', () => {
    const native = setup().python.tool
    const web = setup({ native: null }).python.tool

    assert.equal(native.name, 'python')
    assert.equal(web.name, 'python')
    assert.match(native.description, /sandboxed Python 3 REPL on the local machine/)
    assert.match(web.description, /Pyodide/)
    assert.deepEqual(native.input_schema.required, ['code'])
  })

  it('owns its chat-demo:python toggle, mounts SessionFilesChanged uploads, and writes outputs to BlobStore', async () => {
    const store = memoryStore()
    const blobs = memoryBlobStore()
    await blobs.put([
      { id: 'up-1', blob: new Blob(['a,b'], { type: 'text/csv' }) },
      { id: 'doc-v1', blob: new Blob(['old'], { type: 'text/markdown' }) },
      { id: 'doc-v2', blob: new Blob(['new'], { type: 'text/markdown' }) },
      { id: 'py-old', blob: new Blob(['x'], { type: 'image/png' }) },
    ])

    let counter = 0
    const { fake, events, python } = setup({
      store,
      blobs,
      newId: () => `gen-${++counter}`,
    })

    // Toggle persistence under chat-demo:python
    const toggle = python.capability.toggle
    assert.ok(toggle)
    assert.equal(toggle.isEnabled(), false)
    let notified = 0
    const unsub = toggle.subscribe(() => {
      notified += 1
    })
    toggle.setEnabled(true)
    assert.equal(toggle.isEnabled(), true)
    assert.equal(store.get('chat-demo:python'), 'true')
    assert.equal(notified, 1)
    unsub()

    assert.deepEqual(
      python.capability
        .declareTools({
          questionText: '',
          enabledCapabilities: { python: true },
          declaredToolsSoFar: [],
        })
        .map((t) => t.name),
      ['python']
    )
    assert.deepEqual(
      python.capability.declareTools({
        questionText: '',
        enabledCapabilities: { python: false },
        declaredToolsSoFar: [],
      }),
      []
    )

    // SessionFilesChanged mounts uploads + latest non-python delivered files (excluding python outputs).
    events.publishSticky<SessionFilesChanged>('s1', {
      type: 'SessionFilesChanged',
      sessionId: 's1',
      files: [
        {
          kind: 'upload',
          fileId: 'up-1',
          name: 'raw.csv',
          size: 3,
          mimeType: 'text/csv',
          messageId: 'u1',
          createdAt: 1,
        },
        {
          kind: 'delivered',
          fileId: 'doc-v1',
          name: 'report.md',
          path: 'report.md',
          size: 3,
          mimeType: 'text/markdown',
          producer: 'workspace-files',
          messageId: 'a1',
          createdAt: 2,
        },
        {
          kind: 'delivered',
          fileId: 'py-old',
          name: 'chart.png',
          path: 'chart.png',
          size: 1,
          mimeType: 'image/png',
          producer: 'python',
          messageId: 'a1',
          createdAt: 3,
        },
        {
          kind: 'delivered',
          fileId: 'doc-v2',
          name: 'report.md',
          path: 'report.md',
          size: 3,
          mimeType: 'text/markdown',
          producer: 'workspace-files',
          messageId: 'a2',
          createdAt: 4,
        },
      ],
    })

    fake.setReply(async () =>
      response({
        stdout: 'ok\n',
        files: [{ name: 'out.txt', mimeType: 'text/plain', dataBase64: 'aGk=' }],
      })
    )

    const ctx = {
      sessionId: 's1',
      replyId: 'r1',
      signal: new AbortController().signal,
      caller: { kind: 'reply' as const },
      citedUrls: new Map<string, number>(),
      isActive: () => true,
      onProgress: () => {},
      readReplyState: () => undefined,
      writeReplyState: () => {},
    }

    const res = await python.capability.run(
      { id: 'c1', name: 'python', input: { code: 'print("ok")' } },
      ctx
    )
    assert.equal(res.status, 'ok')
    assert.deepEqual(fake.staged, ['s1:up-1', 's1:doc-v2'])
    assert.equal(res.files?.length, 1)
    assert.equal(res.files?.[0]?.producer, 'python')
    assert.equal(await (await blobs.get('gen-1'))?.text(), 'hi')

    const bad = await python.capability.run({ id: 'c2', name: 'python', input: { src: '1' } }, ctx)
    assert.equal(bad.status, 'error')
    assert.match(bad.content, /Invalid input/)

    const archive = python.capability.serializeForArchive?.(
      { id: 'c1', name: 'python', input: { code: 'print("ok")' } },
      { tool_use_id: 'c1', content: res.content, status: 'ok' }
    )
    assert.equal(archive?.length, 2)

    const Detail = python.capability.presenter?.renderStepDetail
    assert.ok(Detail)
    const detailHtml = renderToStaticMarkup(
      createElement(Detail, {
        entry: {
          call: { id: 'c3', name: 'python', input: { code: 'plot()', summary: 'Plotting trend' } },
          result: {
            tool_use_id: 'c3',
            content: 'ValueError: bad data',
            status: 'error',
            images: ['data:image/png;base64,AA=='],
          },
        },
        sessionId: 's1',
        streaming: false,
        now: 0,
        openLink: () => undefined,
        openVisual: () => undefined,
        renderMarkdown: ({ content }) => createElement('pre', null, content),
      })
    )
    assert.match(detailHtml, /role="note"/)
    assert.match(detailHtml, /ValueError: bad data/)
    assert.match(detailHtml, /<button[^>]*type="button"[^>]*><img/)
    python.dispose()
  })
})

const seeded = (seed: number) => {
  let a = seed >>> 0
  return () => {
    a = (a + 0x6d2b79f5) >>> 0
    let t = a
    t = Math.imul(t ^ (t >>> 15), t | 1)
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61)
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

describe('python slice: randomized kernel queue, ownership, restart notice, staging, & truncation (SPEC 1-9)', () => {
  it('matches an independent SPEC reference model on the native engine across randomized runs, aborts, uploads, and lifecycle facts', async () => {
    const LIMIT = 32
    const SESSIONS = ['s1', 's2', 's3'] as const

    for (let seed = 1; seed <= 20; seed += 1) {
      const rand = seeded(seed * 733 + 11)
      const nextInt = (max: number) => Math.floor(rand() * max)

      let inFlight = 0
      let maxInFlight = 0
      const executedOrder: string[] = []
      const stagedLog: string[] = []
      const repliesByCode = new Map<string, () => Promise<NativeRunResponse>>()

      const host: NativePythonHost = {
        run: async (code) => {
          inFlight += 1
          maxInFlight = Math.max(maxInFlight, inFlight)
          executedOrder.push(code)
          try {
            const fn = repliesByCode.get(code)
            return fn ? await fn() : response()
          } finally {
            inFlight -= 1
          }
        },
        interrupt: async () => undefined,
        reset: async () => undefined,
        stageUpload: async (sessionId, fileId) => {
          stagedLog.push(`${sessionId ?? ''}:${fileId}`)
        },
        onPhase: () => () => undefined,
        runtimeStatus: async () => ({
          ready: true,
          version: '3.12',
          venvPython: null,
          packages: [],
        }),
        resetRuntime: async () => undefined,
      }

      const events = new EventLog()
      const blobs = memoryBlobStore([
        { id: 'u1', blob: new Blob(['csv1']) },
        { id: 'u2', blob: new Blob(['csv2']) },
        { id: 'd1', blob: new Blob(['doc1']) },
        { id: 'py1', blob: new Blob(['pyout']) },
      ])
      const python = createPythonSlice({
        log: events,
        native: host,
        pyodideIndexURL: 'unused://',
        store: memoryStore(),
        blobs,
        now: () => 0,
        params: { outputLimit: LIMIT },
      })

      // Independent SPEC reference model
      let refOwner: string | null = null
      let refNotice = false
      const refStaged = new Set<string>()
      let opCounter = 0

      const expectedRunCodes: string[] = []

      for (let step = 0; step < 30; step += 1) {
        const where = `seed ${seed} step ${step}`
        const action = nextInt(10)

        if (action === 0) {
          const sid = SESSIONS[nextInt(SESSIONS.length)] ?? 's1'
          events.publish<SessionDeleted>({ type: 'SessionDeleted', sessionId: sid })
          if (refOwner === sid) {
            refOwner = null
            refNotice = false
            refStaged.clear()
          }
          continue
        }
        if (action === 1) {
          events.publish<SessionHistoryReplaced>({ type: 'SessionHistoryReplaced' })
          refOwner = null
          refNotice = false
          refStaged.clear()
          continue
        }
        if (action === 2 && python.runtime) {
          await python.runtime.reset()
          refOwner = null
          refNotice = false
          refStaged.clear()
          continue
        }

        // Launch 1..3 concurrent calls (mixing pre-aborted, queued-aborted, and normal runs).
        const batchSize = 1 + nextInt(3)
        const gate = deferred<undefined>()
        const calls: {
          code: string
          sid: string
          mode: 'pre-abort' | 'queued-abort' | 'run'
          restarted: boolean
          stdoutLen: number
          hasError: boolean
          uploadIds: string[]
          promise: Promise<Awaited<ReturnType<typeof python.run>>>
        }[] = []

        for (let b = 0; b < batchSize; b += 1) {
          const code = `op-${++opCounter}`
          const sid = SESSIONS[nextInt(SESSIONS.length)] ?? 's1'
          const modeRoll = rand()
          const mode: 'pre-abort' | 'queued-abort' | 'run' =
            modeRoll < 0.15 ? 'pre-abort' : b > 0 && modeRoll < 0.45 ? 'queued-abort' : 'run'
          const restarted = mode === 'run' && rand() < 0.25
          const lenChoices = [0, LIMIT - 1, LIMIT, LIMIT + 1, LIMIT + 25]
          const stdoutLen = lenChoices[nextInt(lenChoices.length)] ?? 0
          const hasError = mode === 'run' && !restarted && rand() < 0.25

          const uploadIds: string[] = []
          if (rand() < 0.6) {
            uploadIds.push('u1')
          }
          if (rand() < 0.5) {
            uploadIds.push('u2')
          }

          // Also exercise SessionFilesChanged filtering on the last item occasionally.
          if (b === 0 && rand() < 0.35) {
            events.publishSticky<SessionFilesChanged>(sid, {
              type: 'SessionFilesChanged',
              sessionId: sid,
              files: [
                {
                  kind: 'upload',
                  fileId: 'u1',
                  name: 'u1.csv',
                  size: 4,
                  mimeType: 'text/csv',
                  messageId: 'm1',
                  createdAt: 1,
                },
                {
                  kind: 'delivered',
                  fileId: 'd1',
                  name: 'doc.md',
                  path: 'doc.md',
                  size: 4,
                  mimeType: 'text/markdown',
                  producer: 'workspace-files',
                  messageId: 'm2',
                  createdAt: 2,
                },
                {
                  kind: 'delivered',
                  fileId: 'py1',
                  name: 'gen.png',
                  path: 'gen.png',
                  size: 5,
                  mimeType: 'image/png',
                  producer: 'python',
                  messageId: 'm3',
                  createdAt: 3,
                },
              ],
            })
          }

          repliesByCode.set(code, async () => {
            if (b === 0) {
              await gate.promise
            }
            return response({
              stdout: 'a'.repeat(stdoutLen),
              error: hasError ? 'E' : null,
              restarted,
            })
          })

          const ac = new AbortController()
          if (mode === 'pre-abort') {
            ac.abort()
          }
          const promise = python.run(code, {
            signal: ac.signal,
            sessionId: sid,
            uploads: uploadIds.map((id) => ({
              id,
              name: `${id}.csv`,
              loadBlob: async () => new Blob(['x']),
            })),
          })
          if (mode === 'queued-abort') {
            ac.abort()
          }
          calls.push({ code, sid, mode, restarted, stdoutLen, hasError, uploadIds, promise })
        }

        gate.resolve(undefined)
        const outcomes = await Promise.all(calls.map((c) => c.promise))

        for (let i = 0; i < calls.length; i += 1) {
          const call = calls[i]
          const res = outcomes[i]
          if (!call || !res) {
            continue
          }
          if (call.mode !== 'run') {
            assert.equal(
              res.status,
              'aborted',
              `${where} (${call.code}): aborted call must resolve aborted`
            )
            assert.ok(
              !executedOrder.includes(call.code),
              `${where} (${call.code}): aborted call must not reach host`
            )
            continue
          }

          expectedRunCodes.push(call.code)
          if (refOwner !== null && refOwner !== call.sid) {
            refNotice = false
            refStaged.clear()
          }
          refOwner = call.sid
          const expectNotice: boolean = refNotice
          refNotice = false

          for (const uid of call.uploadIds) {
            refStaged.add(`${call.sid}:${uid}`)
          }

          assert.equal(
            res.text.startsWith(RESTART_NOTICE_TAG),
            expectNotice,
            `${where} (${call.code}): restart notice mismatch (expected ${expectNotice}, text=${JSON.stringify(res.text)})`
          )

          if (call.restarted) {
            assert.equal(
              res.status,
              'error',
              `${where} (${call.code}): restarted run reports error`
            )
            refNotice = true
          } else {
            assert.equal(
              res.status,
              call.hasError ? 'error' : 'ok',
              `${where} (${call.code}): status mismatch`
            )
            const body = expectNotice ? res.text.slice(res.text.indexOf('\n\n') + 2) : res.text
            const rawParts = [
              call.stdoutLen > 0 ? 'a'.repeat(call.stdoutLen) : '',
              call.hasError ? 'E' : '',
            ].filter(Boolean)
            const rawText = rawParts.join('\n') || '(no output)'
            if (rawText.length <= LIMIT) {
              assert.equal(body, rawText, `${where} (${call.code}): exact non-truncated output`)
            } else {
              assert.equal(
                body,
                `${rawText.slice(0, LIMIT)}\n… [output truncated: ${rawText.length - LIMIT} more characters]`,
                `${where} (${call.code}): exact truncation boundary`
              )
            }
          }
        }
      }

      assert.equal(maxInFlight, 1, `seed ${seed}: native engine must execute strictly serially`)
      assert.deepEqual(
        executedOrder,
        expectedRunCodes,
        `seed ${seed}: FIFO execution order mismatch`
      )
      assert.ok(
        stagedLog.every((entry) => !entry.endsWith(':py1')),
        `seed ${seed}: python-produced files must never be staged back into uploads/`
      )
      python.dispose()
    }
  })

  it('matches an independent SPEC reference model on the web worker engine across session switches, crashes, aborts, and lifecycle facts', async () => {
    const SESSIONS = ['s1', 's2', 's3'] as const

    for (let seed = 1; seed <= 15; seed += 1) {
      const rand = seeded(seed * 509 + 3)
      const nextInt = (max: number) => Math.floor(rand() * max)

      let workerCount = 0
      let terminations = 0
      let activeWorkerAlive = false
      const plannedMode = new Map<string, 'ok' | 'crash' | 'abort'>()

      const events = new EventLog()
      const python = createPythonSlice({
        log: events,
        native: null,
        pyodideIndexURL: 'unused://',
        store: memoryStore(),
        now: () => 0,
        params: { runTimeoutMs: 50, startupTimeoutMs: 50 },
        spawnWorker: () => {
          workerCount += 1
          activeWorkerAlive = true
          const listeners = {
            message: new Set<(ev: MessageEvent) => void>(),
            error: new Set<(ev: ErrorEvent) => void>(),
          }
          return {
            postMessage: (msg: unknown) => {
              const data = msg as { type?: string; id?: number; code?: string }
              if (data.type === 'init' || !data.code) {
                return
              }
              const mode = plannedMode.get(data.code) ?? 'ok'
              queueMicrotask(() => {
                if (mode === 'crash') {
                  for (const fn of [...listeners.error]) {
                    fn({ message: 'oom' } as ErrorEvent)
                  }
                  return
                }
                if (mode === 'abort') {
                  for (const fn of [...listeners.message]) {
                    fn({ data: { id: data.id, phase: 'running' } } as MessageEvent)
                  }
                  return
                }
                for (const fn of [...listeners.message]) {
                  fn({ data: { id: data.id, phase: 'running' } } as MessageEvent)
                }
                for (const fn of [...listeners.message]) {
                  fn({
                    data: {
                      id: data.id,
                      ok: true,
                      stdout: `ok:${data.code}\n`,
                      result: null,
                      error: null,
                      images: [],
                      dropped: 0,
                      files: [],
                    },
                  } as MessageEvent)
                }
              })
            },
            terminate: () => {
              terminations += 1
              activeWorkerAlive = false
            },
            addEventListener: (type: string, fn: EventListenerOrEventListenerObject) => {
              if (type === 'message') {
                listeners.message.add(fn as (ev: MessageEvent) => void)
              } else if (type === 'error') {
                listeners.error.add(fn as (ev: ErrorEvent) => void)
              }
            },
            removeEventListener: (type: string, fn: EventListenerOrEventListenerObject) => {
              if (type === 'message') {
                listeners.message.delete(fn as (ev: MessageEvent) => void)
              } else if (type === 'error') {
                listeners.error.delete(fn as (ev: ErrorEvent) => void)
              }
            },
          }
        },
      })

      let refOwner: string | null = null
      let refNotice = false
      let refWorkerAlive = false
      let opCounter = 0

      for (let step = 0; step < 25; step += 1) {
        const where = `web seed ${seed} step ${step}`
        const roll = nextInt(10)

        if (roll === 0) {
          const sid = SESSIONS[nextInt(SESSIONS.length)] ?? 's1'
          events.publish<SessionDeleted>({ type: 'SessionDeleted', sessionId: sid })
          if (refOwner === sid) {
            refOwner = null
            refNotice = false
            refWorkerAlive = false
          }
          assert.equal(
            activeWorkerAlive,
            refWorkerAlive,
            `${where}: worker alive after SessionDeleted(${sid})`
          )
          continue
        }
        if (roll === 1) {
          events.publish<SessionHistoryReplaced>({ type: 'SessionHistoryReplaced' })
          refOwner = null
          refNotice = false
          refWorkerAlive = false
          assert.equal(
            activeWorkerAlive,
            false,
            `${where}: worker terminated on SessionHistoryReplaced`
          )
          continue
        }

        const code = `w-${++opCounter}`
        const sid = SESSIONS[nextInt(SESSIONS.length)] ?? 's1'
        const modeRoll = rand()
        const mode: 'ok' | 'crash' | 'abort' =
          modeRoll < 0.25 ? 'crash' : modeRoll < 0.45 ? 'abort' : 'ok'
        plannedMode.set(code, mode)

        if (refOwner !== null && refOwner !== sid) {
          // Cross-session switch silently resets web worker with NO notice.
          refWorkerAlive = false
          refNotice = false
        }
        refOwner = sid
        const expectNotice: boolean = refNotice
        refNotice = false

        const ac = new AbortController()
        const prevTerms = terminations
        const runPromise = python.run(code, {
          signal: ac.signal,
          sessionId: sid,
          onPhase: (phase) => {
            if (mode === 'abort' && phase === 'running') {
              ac.abort()
            }
          },
        })
        const res = await runPromise

        if (mode === 'ok') {
          refWorkerAlive = true
          assert.equal(res.status, 'ok', `${where}: ok run`)
          assert.equal(
            res.text.startsWith(RESTART_NOTICE_TAG),
            expectNotice,
            `${where}: web restart notice mismatch (expected ${expectNotice}, got ${JSON.stringify(res.text)})`
          )
        } else if (mode === 'crash') {
          refWorkerAlive = false
          refOwner = null
          refNotice = true
          assert.equal(res.status, 'error', `${where}: crash run`)
          assert.ok(terminations > prevTerms, `${where}: crashed worker must be terminated`)
        } else {
          refWorkerAlive = false
          refOwner = null
          refNotice = true
          assert.equal(res.status, 'aborted', `${where}: aborted run`)
          assert.ok(terminations > prevTerms, `${where}: aborted web worker must be terminated`)
        }
      }

      assert.ok(workerCount >= 1)
      python.dispose()
    }
  })
})
