/**
 * Store-level test environment: the real slice over fake IndexedDB, a scripted DeepSeek API, and a
 * recording tool gateway. Import first in a test file; the slice is created once per process.
 */
import 'fake-indexeddb/auto'
import { memoryStore } from '@deepseek-chat/spine/ports'
import { EventLog } from '@deepseek-chat/spine/runtime'
import type {
  AgentProfile,
  ConversationsParams,
  StreamTrace,
  ToolCallPart,
  ToolCaller,
  ToolEffect,
  ToolKind,
  ToolResult,
  ToolRunContext,
} from '@deepseek-chat/slice-conversations'
import { installTestSlice } from './harness.js'

// A hidden page: the store writes each streamed event straight away instead of per frame.
Object.assign(globalThis, {
  document: { visibilityState: 'hidden' },
  requestAnimationFrame: (callback: () => void) => setTimeout(callback, 0),
  cancelAnimationFrame: (id: ReturnType<typeof setTimeout>) => clearTimeout(id),
})

// ---------- the scripted API ----------

/** What a request asked for, as the API sees it. */
export type ApiRequest = {
  readonly model: string
  readonly system: string
  readonly messages: { role: string; content: unknown }[]
  readonly tools: { name: string }[]
  readonly tool_choice?: { type: string; name?: string }
}

/** One scripted reply: text, tool calls (each `{ name, input }`), or an HTTP error status. */
export type ApiReply =
  | { readonly text: string; readonly title?: string }
  | { readonly calls: readonly { name: string; input: unknown }[] }
  | { readonly errorStatus: number; readonly errorMessage: string }

const usage = {
  input_tokens: 1,
  cache_creation_input_tokens: 0,
  cache_read_input_tokens: 0,
  output_tokens: 1,
}

const toEvents = (reply: Exclude<ApiReply, { errorStatus: number }>, callIds: () => string) => {
  const blocks =
    'text' in reply
      ? [{ start: { type: 'text', text: '' }, delta: { type: 'text_delta', text: reply.text } }]
      : reply.calls.map((call) => ({
          start: { type: 'tool_use', id: callIds(), name: call.name, input: {} },
          delta: { type: 'input_json_delta', partial_json: JSON.stringify(call.input) },
        }))
  return [
    { type: 'message_start', message: { id: 'm', role: 'assistant', content: [], usage } },
    ...blocks.flatMap((block, index) => [
      { type: 'content_block_start', index, content_block: block.start },
      { type: 'content_block_delta', index, delta: block.delta },
      { type: 'content_block_stop', index },
    ]),
    {
      type: 'message_delta',
      delta: {
        stop_reason: 'text' in reply ? 'end_turn' : 'tool_use',
        ...('text' in reply && reply.title ? { title: reply.title } : {}),
      },
      usage,
    },
    { type: 'message_stop' },
  ]
}

const sseResponse = (events: unknown[]) =>
  new Response(
    events
      .map((e) => `event: ${(e as { type: string }).type}\ndata: ${JSON.stringify(e)}\n\n`)
      .join(''),
    { headers: { 'Content-Type': 'text/event-stream' } }
  )

// ---------- the recording gateway ----------

export type GatewayRun = {
  readonly call: ToolCallPart
  /** The call's own running result, as the context showed it when the run started. */
  readonly runningPhase: string | undefined
  readonly context: ToolRunContext
}

const effectForKind = (kind: ToolKind | null): ToolEffect => {
  switch (kind) {
    case 'web_search':
    case 'web_scrape':
    case 'read_file':
      return 'read'
    case 'subagent':
      return 'spawn'
    case 'present_file':
    case 'edit_file':
      return 'artifact'
    case 'ask_user':
      return 'interactive'
    default:
      return 'session'
  }
}

export const createStoreEnv = (
  options: {
    kinds?: Record<string, ToolKind>
    effects?: Record<string, ToolEffect>
    profiles?: Record<string, AgentProfile>
    instructions?: (names: ReadonlySet<string>, audience: ToolCaller['kind']) => string[]
    autoTitle?: boolean
    params?: Partial<ConversationsParams>
  } = {}
) => {
  const requests: ApiRequest[] = []
  let respond: (
    request: ApiRequest,
    signal?: AbortSignal
  ) => ApiReply | Promise<ApiReply> = () => ({
    text: 'ok',
  })
  let callCounter = 0
  const runs: GatewayRun[] = []
  let runTool: (call: ToolCallPart, context: ToolRunContext) => Promise<ToolResult> = async (
    call
  ) => ({ content: `ran ${call.name}`, status: 'ok' })
  const log = new EventLog()
  const kinds = options.kinds ?? {}
  const effects = options.effects ?? {}
  const profiles = options.profiles ?? {}
  const traces: StreamTrace[] = []

  const slice = installTestSlice({
    log,
    autoTitle: options.autoTitle ?? false,
    params: options.params,
    onStreamTrace: (trace) => {
      traces.push(trace)
    },
    fetch: async (url, init) => {
      if (!url.endsWith('/messages')) {
        throw new Error(`unexpected request ${url}`)
      }
      const body = JSON.parse(String(init.body)) as ApiRequest
      requests.push(body)
      const reply = await respond(body, init.signal ?? undefined)
      if ('errorStatus' in reply) {
        return new Response(JSON.stringify({ error: { message: reply.errorMessage } }), {
          status: reply.errorStatus,
          headers: { 'Content-Type': 'application/json' },
        })
      }
      return sseResponse(toEvents(reply, () => `call${++callCounter}`))
    },
    store: memoryStore(),
    tools: {
      declare: () =>
        Object.keys(kinds).map((name) => ({ name, description: name, input_schema: {} })),
      instructions: options.instructions ?? (() => []),
      describe: (name) =>
        Object.hasOwn(kinds, name) ? { name, description: name, input_schema: {} } : null,
      kindOf: (name) => kinds[name] ?? null,
      effectOf: (name) => effects[name] ?? effectForKind(kinds[name] ?? null),
      agentProfile: (name) => (Object.hasOwn(profiles, name) ? profiles[name] : null),
      fenceLanguage: () => 'text',
      run: (call, context) => {
        const running = context.replyBlocks.find(
          (block) => block.type === 'tool_result' && block.tool_use_id === call.id
        )
        runs.push({
          call,
          runningPhase: running?.type === 'tool_result' ? running.phase : undefined,
          context,
        })
        return runTool(call, context)
      },
    },
  })

  return {
    slice,
    log,
    requests,
    runs,
    /** Stream traces reported through `onStreamTrace`, in order. */
    traces,
    /** Sets how the API answers each request. */
    respondWith: (
      fn: (request: ApiRequest, signal?: AbortSignal) => ApiReply | Promise<ApiReply>
    ) => {
      respond = fn
    },
    /** Sets how the gateway runs each call. */
    runToolsWith: (fn: typeof runTool) => {
      runTool = fn
    },
    facts: <F extends { type: string }>(type: F['type']) => {
      const seen: F[] = []
      log.subscribe<F>(type, ({ fact }) => {
        seen.push(fact)
      })
      return seen
    },
  }
}

export type StoreEnv = ReturnType<typeof createStoreEnv>

/** Sends `text` in `sessionId` (null: a new chat) and waits for the reply to finish. */
export const say = async (env: StoreEnv, sessionId: string | null, text: string) => {
  env.slice.commands.setDraft(sessionId, text)
  const sent = env.slice.commands.send(sessionId)
  await env.slice.commands.whenIdle()
  return sent
}

/** A tiny seeded PRNG (mulberry32) for reproducible randomized invariants. */
export const seeded = (seed: number) => {
  let a = seed >>> 0
  return () => {
    a = (a + 0x6d2b79f5) >>> 0
    let t = a
    t = Math.imul(t ^ (t >>> 15), t | 1)
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61)
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}
