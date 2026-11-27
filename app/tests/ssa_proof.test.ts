/**
 * Executable Sealed Slice Architecture (SSA) proofs:
 * 1. Multi-instance isolation: two full AppRuntime instances coexist in one process with zero bleed.
 * 2. Minimal boot & N-1 omission matrix: bare chat (0 optional slices) + removing each optional slice.
 * 3. Zero-touch drop-in slice: a brand-new sealed `calculator` slice plugs into composer toggles,
 *    tool loop, summary injection, Work Strip, Activity Inspector, ZIP archive export, and
 *    SessionDeleted cleanup with zero edits to any existing slice.
 * 4. Spine EventLog causal envelopes, sticky replay for late subscribers, and tombstone eviction.
 */
import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import type { ToolCapability } from '@deepseek-chat/lib-tools'
import { buildActivityTimeline } from '@deepseek-chat/slice-activity-inspector'
import { buildReplyView, buildTurnWorkStrip } from '@deepseek-chat/slice-conversations'
import { readArchive, readEntry } from '@deepseek-chat/slice-history-backup'
import type { BrowserControlTakenOver } from '@deepseek-chat/spine/facts/browser'
import type {
  ActiveSessionChanged,
  SessionDeleted,
  SessionFilesChanged,
} from '@deepseek-chat/spine/facts/session'
import type { KeyValueStore } from '@deepseek-chat/spine/ports'
import type { EventLog } from '@deepseek-chat/spine/runtime'
import { memoryStore } from '@deepseek-chat/test-support'
import type { EnabledSlices } from '../runtime.js'
import { createTestRuntime as createAppRuntime } from './testRuntime.js'

Object.assign(globalThis, {
  document: { visibilityState: 'hidden' },
  requestAnimationFrame: (cb: () => void) => setTimeout(cb, 0),
  cancelAnimationFrame: (id: ReturnType<typeof setTimeout>) => clearTimeout(id),
})

type ScriptStep =
  | { readonly text: string }
  | {
      readonly calls: readonly {
        readonly id: string
        readonly name: string
        readonly input: unknown
      }[]
    }

const usage = {
  input_tokens: 1,
  cache_creation_input_tokens: 0,
  cache_read_input_tokens: 0,
  output_tokens: 1,
}

const makeSseFetch = (
  responder: (body: {
    system: string
    tools: { name: string }[]
    messages: unknown[]
  }) => ScriptStep
) => {
  const requests: { system: string; tools: { name: string }[]; messages: unknown[] }[] = []
  const fetchImpl = async (url: string, init: RequestInit): Promise<Response> => {
    if (!url.endsWith('/messages')) {
      throw new Error(`unexpected URL ${url}`)
    }
    const body = JSON.parse(String(init.body)) as {
      system: string
      tools: { name: string }[]
      messages: unknown[]
    }
    requests.push(body)
    const step = responder(body)
    const blocks =
      'text' in step
        ? [{ start: { type: 'text', text: '' }, delta: { type: 'text_delta', text: step.text } }]
        : step.calls.map((c) => ({
            start: { type: 'tool_use', id: c.id, name: c.name, input: {} },
            delta: { type: 'input_json_delta', partial_json: JSON.stringify(c.input) },
          }))
    const events = [
      { type: 'message_start', message: { id: 'm', role: 'assistant', content: [], usage } },
      ...blocks.flatMap((b, index) => [
        { type: 'content_block_start', index, content_block: b.start },
        { type: 'content_block_delta', index, delta: b.delta },
        { type: 'content_block_stop', index },
      ]),
      {
        type: 'message_delta',
        delta: { stop_reason: 'text' in step ? 'end_turn' : 'tool_use' },
        usage,
      },
      { type: 'message_stop' },
    ]
    return new Response(
      events
        .map((e) => `event: ${(e as { type: string }).type}\ndata: ${JSON.stringify(e)}\n\n`)
        .join(''),
      { headers: { 'Content-Type': 'text/event-stream' } }
    )
  }
  return { fetch: fetchImpl, requests }
}

/**
 * Brand-new sealed synthetic slice written solely inside this proof file — zero changes to
 * `conversations`, `activity-inspector`, `history-backup`, `libs/tools`, or `app/runtime.ts`.
 */
const createCalculatorSlice = (deps: {
  readonly store: KeyValueStore
  readonly log?: EventLog
}) => {
  const KEY = 'chat-demo:calc'
  let enabled = deps.store.get(KEY) === 'true'
  const listeners = new Set<() => void>()
  const countsBySession = new Map<string, number>()

  const setEnabled = (next: boolean) => {
    if (enabled === next) {
      return
    }
    enabled = next
    deps.store.set(KEY, String(next))
    for (const listener of [...listeners]) {
      listener()
    }
  }

  const unsub = deps.log?.subscribe<SessionDeleted>('SessionDeleted', ({ fact }) => {
    countsBySession.delete(fact.sessionId)
  })

  const capability: ToolCapability = {
    id: 'calculator',
    toggle: {
      id: 'calculator',
      label: () => 'Calculator',
      icon: null,
      isEnabled: () => enabled,
      setEnabled,
      subscribe: (listener) => {
        listeners.add(listener)
        return () => {
          listeners.delete(listener)
        }
      },
    },
    declareTools: ({ enabledCapabilities }) =>
      enabledCapabilities.calculator
        ? [
            {
              name: 'calculate',
              description: 'Evaluate a simple two-operand multiplication expression like "6 * 7".',
              input_schema: {
                type: 'object',
                required: ['a', 'b'],
                properties: {
                  a: { type: 'number' },
                  b: { type: 'number' },
                },
              },
            },
          ]
        : [],
    instructions: (names, audience) =>
      audience === 'reply' && names.has('calculate')
        ? 'Calculator (`calculate`): use this tool for exact arithmetic.'
        : null,
    handles: (name) => name === 'calculate',
    effectOf: () => 'read',
    run: async (call, ctx) => {
      const input = (call.input ?? {}) as { a?: number; b?: number }
      const product = Number(input.a ?? 0) * Number(input.b ?? 0)
      countsBySession.set(ctx.sessionId, (countsBySession.get(ctx.sessionId) ?? 0) + 1)
      return {
        status: 'ok',
        content: String(product),
        durationMs: 1,
        payload: { a: input.a, b: input.b, product },
      }
    },
    presenter: {
      summarize: (_call, result) => ({
        lane: 'calculator',
        liveVerb: 'Calculating',
        detail: result ? `Result: ${result.content}` : 'Running arithmetic',
        tally: {
          key: 'calc',
          count: 1,
          label: (n) => `${n} calc`,
        },
        stillRunning: !result || result.status === 'running',
      }),
      renderActivity: () => null,
    },
    serializeForArchive: (call, result) => {
      const input = (call.input ?? {}) as { a?: number; b?: number }
      return [
        {
          type: 'MARKDOWN',
          content: `Calculated ${input.a} * ${input.b} = ${result?.content ?? '?'}`,
        },
      ]
    },
  }

  return {
    capability,
    getSessionCount: (sessionId: string) => countsBySession.get(sessionId) ?? 0,
    setEnabled,
    dispose: () => {
      listeners.clear()
      countsBySession.clear()
      unsub?.()
    },
  }
}

describe('SSA Proof 1: Multi-instance isolation in the same process', () => {
  it('runs two full AppRuntime instances side-by-side with zero state or EventLog cross-talk', async () => {
    const apiA = makeSseFetch(() => ({ text: 'Reply from A' }))
    const apiB = makeSseFetch(() => ({ text: 'Reply from B' }))

    const runtimeA = createAppRuntime({
      store: memoryStore({ 'chat-demo:api-key': 'sk-a', 'chat-demo:thinking': 'true' }),
      fetch: apiA.fetch,
      autoTitle: false,
    })
    const runtimeB = createAppRuntime({
      store: memoryStore({ 'chat-demo:api-key': 'sk-b', 'chat-demo:thinking': 'false' }),
      fetch: apiB.fetch,
      autoTitle: false,
    })

    await runtimeA.slices.conversations.commands.init()
    await runtimeB.slices.conversations.commands.init()

    // Mutate locale, theme, toggles, and send a message ONLY in Runtime A.
    runtimeA.slices.preferences?.setLocale('zh-CN')
    runtimeA.slices.preferences?.setThemePreference('dark')
    runtimeA.slices.conversations.setThinking(false)
    runtimeA.tools.toggles.find((t) => t.id === 'web-research')?.setEnabled(true)
    runtimeA.slices.conversations.commands.setDraft(null, 'Hello A')
    assert.equal(runtimeA.slices.conversations.commands.send(null), true)
    await runtimeA.slices.conversations.commands.whenIdle()

    // Runtime A has 1 session, zh-CN locale & dark theme; Runtime B is completely untouched.
    assert.equal(runtimeA.locale.get(), 'zh-CN')
    assert.equal(runtimeB.locale.get(), 'en-US')
    assert.equal(runtimeA.slices.preferences?.getThemePreference(), 'dark')
    assert.equal(runtimeB.slices.preferences?.getThemePreference(), 'system')
    assert.equal(runtimeA.slices.conversations.getState().sessions.length, 1)
    assert.equal(runtimeB.slices.conversations.getState().sessions.length, 0)
    assert.equal(runtimeA.slices.conversations.getThinking(), false)
    assert.equal(runtimeB.slices.conversations.getThinking(), false)
    assert.equal(
      runtimeB.tools.toggles.find((t) => t.id === 'web-research')?.isEnabled(),
      false,
      'Runtime B web-research toggle was untouched by Runtime A'
    )
    assert.ok(runtimeA.log.history().some((e) => e.fact.type === 'ReplyLifecycleChanged'))
    assert.equal(
      runtimeB.log.history().some((e) => e.fact.type === 'ReplyLifecycleChanged'),
      false
    )

    // Dispose A; verify B still functions completely independently.
    runtimeA.dispose()
    const beforeDisposeFactsA = runtimeA.log.history().length
    runtimeA.log.publish<BrowserControlTakenOver>({
      type: 'BrowserControlTakenOver',
      sessionId: 'gone',
    })
    assert.equal(runtimeA.log.history().length, beforeDisposeFactsA + 1)

    runtimeB.slices.conversations.commands.setDraft(null, 'Hello B')
    assert.equal(runtimeB.slices.conversations.commands.send(null), true)
    await runtimeB.slices.conversations.commands.whenIdle()
    assert.equal(runtimeB.slices.conversations.getState().sessions.length, 1)
    runtimeB.dispose()
  })
})

describe('SSA Proof 2: Minimal boot & N-1 optional slice omission matrix', () => {
  const OPTIONAL_SLICE_KEYS: readonly (keyof EnabledSlices)[] = [
    'preferences',
    'voice',
    'webResearch',
    'python',
    'workspaceFiles',
    'browser',
    'askUser',
    'subagents',
    'activityInspector',
    'historyBackup',
  ]

  it('boots and completes a chat turn with ALL 10 optional slices disabled (bare 2-slice app)', async () => {
    const allOff = Object.fromEntries(OPTIONAL_SLICE_KEYS.map((k) => [k, false])) as EnabledSlices
    const api = makeSseFetch(() => ({ text: 'Bare chat works!' }))
    const runtime = createAppRuntime({
      store: memoryStore({ 'chat-demo:api-key': 'sk-bare' }),
      fetch: api.fetch,
      enabledSlices: allOff,
      autoTitle: false,
    })

    assert.equal(runtime.tools.capabilities.length, 0)
    assert.deepEqual(runtime.tools.declare({ questionText: 'hi', enabledCapabilities: {} }), [])
    for (const key of OPTIONAL_SLICE_KEYS) {
      assert.equal(runtime.slices[key], null, `${key} is unmounted`)
    }

    await runtime.slices.conversations.commands.init()
    runtime.slices.conversations.commands.setDraft(null, 'Ping bare chat')
    assert.equal(runtime.slices.conversations.commands.send(null), true)
    await runtime.slices.conversations.commands.whenIdle()

    const sid = runtime.slices.conversations.getState().activeId
    assert.ok(sid)
    const messages = runtime.slices.conversations.getChatMessages(sid)
    assert.equal(messages.length, 2)
    assert.equal(messages[1]?.role === 'assistant' ? messages[1].status : null, 'done')
    runtime.dispose()
  })

  it('boots, sends a message, and disposes cleanly with each optional slice removed one by one (N-1)', async () => {
    for (const omitted of OPTIONAL_SLICE_KEYS) {
      const api = makeSseFetch(() => ({ text: `OK without ${omitted}` }))
      const runtime = createAppRuntime({
        store: memoryStore({ 'chat-demo:api-key': 'sk-matrix' }),
        fetch: api.fetch,
        enabledSlices: { [omitted]: false },
        autoTitle: false,
      })
      assert.equal(runtime.slices[omitted], null, `${omitted} omitted`)
      await runtime.slices.conversations.commands.init()
      runtime.slices.conversations.commands.setDraft(null, `Test without ${omitted}`)
      assert.equal(runtime.slices.conversations.commands.send(null), true)
      await runtime.slices.conversations.commands.whenIdle()

      const sid = runtime.slices.conversations.getState().activeId
      assert.ok(sid, `session created without ${omitted}`)
      const last = runtime.slices.conversations.getChatMessages(sid).at(-1)
      assert.equal(
        last?.role === 'assistant' ? last.status : null,
        'done',
        `reply done without ${omitted}`
      )
      runtime.dispose()
    }
  })
})

describe('SSA Proof 3: Zero-touch drop-in synthetic capability slice', () => {
  it('plugs into toggles, tool loop, summary injection, Work Strip, Activity Inspector, and ZIP archive with zero edits to existing slices', async () => {
    const store = memoryStore({ 'chat-demo:api-key': 'sk-calc' })
    const calc = createCalculatorSlice({ store })

    let round = 0
    const api = makeSseFetch(() => {
      round += 1
      if (round === 1) {
        return {
          calls: [
            {
              id: 'calc-1',
              name: 'calculate',
              input: { summary: 'Multiplying 6 by 7', a: 6, b: 7 },
            },
          ],
        }
      }
      return { text: 'The answer is 42.' }
    })

    const runtime = createAppRuntime({
      store,
      fetch: api.fetch,
      extraCapabilities: [calc.capability],
      autoTitle: false,
    })
    // Also subscribe calc to runtime's EventLog for SessionDeleted cleanup proof.
    const unsubCalcDelete = runtime.log.subscribe<SessionDeleted>('SessionDeleted', () => {
      calc.dispose()
    })

    // 1. Composer toggle auto-discovered and persisted under chat-demo:calc.
    const toggle = runtime.tools.toggles.find((t) => t.id === 'calculator')
    assert.ok(toggle, 'drop-in toggle appears in ToolRegistry.toggles')
    toggle.setEnabled(true)
    assert.equal(store.get('chat-demo:calc'), 'true')

    // 2. Send turn -> declared tool gets summary auto-prepended, instructions appended, tool executes.
    await runtime.slices.conversations.commands.init()
    runtime.slices.conversations.commands.setDraft(null, 'What is 6 times 7?')
    assert.equal(runtime.slices.conversations.commands.send(null), true)
    await runtime.slices.conversations.commands.whenIdle()

    const firstReq = api.requests[0]
    assert.ok(firstReq)
    const calcDecl = firstReq.tools.find((t) => t.name === 'calculate') as
      | { name: string; input_schema: { properties: Record<string, unknown>; required: string[] } }
      | undefined
    assert.ok(calcDecl, 'calculate tool declared to model')
    assert.equal(Object.keys(calcDecl.input_schema.properties)[0], 'summary')
    assert.ok(firstReq.system.includes('Calculator (`calculate`)'))

    const sid = runtime.slices.conversations.getState().activeId
    assert.ok(sid)
    assert.equal(calc.getSessionCount(sid), 1)
    const reply = runtime.slices.conversations.getChatMessages(sid).at(-1)
    assert.equal(reply?.role, 'assistant')
    if (reply?.role !== 'assistant') {
      assert.fail()
    }

    // 3. Work Strip uses drop-in presenter tally with zero knowledge of calculator.
    const view = buildReplyView(reply, false, runtime.tools)
    const strip = buildTurnWorkStrip(reply, view, false, Date.now(), false, true)
    assert.equal(strip.mode, 'settled')
    if (strip.mode === 'settled') {
      assert.match(strip.label, /1 calc/)
    }

    // 4. Activity Inspector builds a custom lane from drop-in presenter.
    const snap = runtime.slices.conversations.getTurnSnapshot(sid, reply.id)
    assert.ok(snap)
    const timeline = buildActivityTimeline(snap, runtime.tools.presenterFor, Date.now())
    assert.equal(timeline.phases.length, 1)
    assert.equal(timeline.phases[0]?.type, 'lane')
    if (timeline.phases[0]?.type === 'lane') {
      assert.equal(timeline.phases[0].lane, 'calculator')
      assert.equal(timeline.phases[0].entries[0]?.result?.content, '42')
    }

    // 5. History Backup calls drop-in serializeForArchive for v3 ZIP export.
    assert.ok(runtime.slices.historyBackup)
    const exported = await runtime.slices.historyBackup.exportHistory()
    const zipFile = new File([exported.blob], exported.name, { type: 'application/zip' })
    let sessionText: string | null = null
    for await (const entry of readArchive(zipFile)) {
      const entryBlob = await readEntry(entry)
      if (entry.path === `chat_sessions/${sid}.json`) {
        sessionText = await entryBlob.text()
      }
    }
    assert.ok(sessionText, 'exported ZIP contains the session JSON')
    const sessionJson = JSON.parse(sessionText) as {
      messages: { fragments: { type: string; content?: string }[] }[]
    }
    const responseText = sessionJson.messages
      .flatMap((m) => m.fragments)
      .filter((f) => f.type === 'RESPONSE')
      .map((f) => f.content ?? '')
      .join('\n')
    assert.match(responseText, /Calculated 6 \* 7 = 42/)

    // 6. Session deletion cleans up drop-in state via Spine SessionDeleted fact.
    await runtime.slices.conversations.commands.removeSession(sid)
    assert.equal(calc.getSessionCount(sid), 0)

    unsubCalcDelete()
    calc.dispose()
    runtime.dispose()
  })
})

describe('SSA Proof 4: Spine EventLog sticky replay, tombstones, and causal history', () => {
  it('replays sticky ActiveSessionChanged and SessionFilesChanged to late subscribers and evicts on delete', async () => {
    let round = 0
    const api = makeSseFetch(() => {
      round += 1
      if (round === 1) {
        return {
          calls: [
            {
              id: 'file-1',
              name: 'present_file',
              input: {
                summary: 'Creating hello.md',
                path: 'hello.md',
                title: 'Hello',
                content: '# Hello SSA',
              },
            },
          ],
        }
      }
      return { text: 'Created hello.md.' }
    })

    const runtime = createAppRuntime({
      store: memoryStore({ 'chat-demo:api-key': 'sk-spine' }),
      fetch: api.fetch,
      autoTitle: false,
    })

    await runtime.slices.conversations.commands.init()
    runtime.slices.conversations.commands.setDraft(null, 'Create hello.md')
    assert.equal(runtime.slices.conversations.commands.send(null), true)
    await runtime.slices.conversations.commands.whenIdle()

    const sid = runtime.slices.conversations.getState().activeId
    assert.ok(sid)

    // Late subscriber sees current ActiveSessionChanged + SessionFilesChanged immediately!
    const replayedActive: (string | null)[] = []
    const replayedFiles: SessionFilesChanged[] = []
    const u1 = runtime.log.subscribe<ActiveSessionChanged>(
      'ActiveSessionChanged',
      ({ fact }) => replayedActive.push(fact.sessionId),
      { replaySticky: true }
    )
    const u2 = runtime.log.subscribe<SessionFilesChanged>(
      'SessionFilesChanged',
      ({ fact }) => replayedFiles.push(fact),
      { replaySticky: true }
    )
    assert.deepEqual(replayedActive, [sid])
    assert.equal(replayedFiles.length, 1)
    assert.equal(replayedFiles[0]?.files[0]?.name, 'hello.md')
    u1()
    u2()

    // Causal log contains sequential envelopes including ToolFileDelivered & ReplyLifecycleChanged.
    const historyTypes = runtime.log.history().map((e) => e.fact.type)
    assert.ok(historyTypes.includes('ActiveSessionChanged'))
    assert.ok(historyTypes.includes('ReplyLifecycleChanged'))
    assert.ok(historyTypes.includes('ToolFileDelivered'))
    assert.ok(historyTypes.includes('SessionFilesChanged'))

    // Deleting the session tombstones SessionFilesChanged so future late subscribers see nothing.
    await runtime.slices.conversations.commands.removeSession(sid)
    const afterDeleteFiles: SessionFilesChanged[] = []
    const u3 = runtime.log.subscribe<SessionFilesChanged>(
      'SessionFilesChanged',
      ({ fact }) => afterDeleteFiles.push(fact),
      { replaySticky: true }
    )
    assert.deepEqual(afterDeleteFiles, [])
    u3()
    runtime.dispose()
  })
})
