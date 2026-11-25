/**
 * Store-level test environment: an isolated conversations slice over in-memory stores,
 * a scripted DeepSeek API, and a recording ToolCapability.
 */
import {
  createToolRegistry,
  type ToolCallRecord,
  type ToolCapability,
  type ToolEffect,
  type ToolProgress,
  type ToolRunContext,
  type ToolRunResult,
  type ToolStepPresenter,
  type TurnLifecycleHooks,
} from '@deepseek-chat/lib-tools'
import { memoryBlobStore, memoryStore } from '@deepseek-chat/spine/ports'
import { EventLog } from '@deepseek-chat/spine/runtime'
import {
  memorySessionStore,
  type ConversationsParams,
  type StreamTrace,
} from '@deepseek-chat/slice-conversations'
import { createTestSlice } from './harness.js'

// A hidden page: the store writes each streamed event straight away instead of per frame.
Object.assign(globalThis, {
  document: { visibilityState: 'hidden' },
  requestAnimationFrame: (callback: () => void) => setTimeout(callback, 0),
  cancelAnimationFrame: (id: ReturnType<typeof setTimeout>) => clearTimeout(id),
})

// ---------- the scripted API ----------

export type ApiRequest = {
  readonly model: string
  readonly system: string
  readonly messages: { role: string; content: unknown }[]
  readonly tools: { name: string }[]
  readonly tool_choice?: { type: string; name?: string }
  readonly thinking?: { type: string }
}

export type ApiReply =
  | {
      readonly text: string
      readonly title?: string
      readonly dropMessageStop?: boolean
      readonly cutAfterContent?: boolean
    }
  | {
      readonly calls: readonly { name: string; input: unknown }[]
      readonly dropMessageStop?: boolean
    }
  | { readonly errorStatus: number; readonly errorMessage: string }
  | { readonly networkError: string }

const usage = {
  input_tokens: 1,
  cache_creation_input_tokens: 0,
  cache_read_input_tokens: 0,
  output_tokens: 1,
}

const toEvents = (
  reply: Exclude<ApiReply, { errorStatus: number } | { networkError: string }>,
  callIds: () => string
) => {
  const blocks =
    'text' in reply
      ? [{ start: { type: 'text', text: '' }, delta: { type: 'text_delta', text: reply.text } }]
      : reply.calls.map((call) => ({
          start: { type: 'tool_use', id: callIds(), name: call.name, input: {} },
          delta: { type: 'input_json_delta', partial_json: JSON.stringify(call.input) },
        }))
  const start = {
    type: 'message_start',
    message: { id: 'm', role: 'assistant', content: [], usage },
  }
  if ('text' in reply && reply.cutAfterContent) {
    const [block] = blocks
    return [
      start,
      { type: 'content_block_start', index: 0, content_block: block?.start },
      { type: 'content_block_delta', index: 0, delta: block?.delta },
    ]
  }
  return [
    start,
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
    ...(reply.dropMessageStop ? [] : [{ type: 'message_stop' }]),
  ]
}

const sseResponse = (events: unknown[]) =>
  new Response(
    events
      .map((e) => `event: ${(e as { type: string }).type}\ndata: ${JSON.stringify(e)}\n\n`)
      .join(''),
    { headers: { 'Content-Type': 'text/event-stream' } }
  )

export type UploadReply =
  | { readonly id: string }
  | { readonly errorStatus: number; readonly errorMessage: string }

export const fileGoneError = (fileId: string): ApiReply => ({
  errorStatus: 400,
  errorMessage: `file_ids do not exist or are not created under your account: ${fileId}`,
})

const jsonResponse = (status: number, body: unknown) =>
  new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } })

// ---------- the recording tool capability ----------

export type RecordedRun = {
  readonly call: ToolCallRecord
  readonly initialPhase: string | undefined
  readonly context: ToolRunContext
}

export const createStoreEnv = (
  options: {
    toolNames?: readonly string[]
    effects?: Readonly<Record<string, ToolEffect>>
    initialProgress?: (name: string) => ToolProgress | undefined
    instructions?: (names: ReadonlySet<string>) => string | null
    presenter?: ToolStepPresenter
    turnHooks?: TurnLifecycleHooks
    extraCapabilities?: readonly ToolCapability[]
    autoTitle?: boolean
    params?: Partial<ConversationsParams>
  } = {}
) => {
  const requests: ApiRequest[] = []
  let respond: (
    request: ApiRequest,
    signal?: AbortSignal
  ) => ApiReply | Promise<ApiReply> = () => ({ text: 'ok' })
  let callCounter = 0
  const runs: RecordedRun[] = []
  let runTool: (call: ToolCallRecord, context: ToolRunContext) => Promise<ToolRunResult> = async (
    call
  ) => ({ content: `ran ${call.name}`, status: 'ok' })

  const log = new EventLog()
  const blobs = memoryBlobStore()
  const sessions = memorySessionStore()
  const store = memoryStore()
  const toolNames = options.toolNames ?? []
  const effects = options.effects ?? {}
  const traces: StreamTrace[] = []
  const uploads: string[] = []
  let respondToUpload: (name: string, index: number) => UploadReply | Promise<UploadReply> = (
    _name,
    index
  ) => ({ id: `file-api-${index + 1}` })

  const recordedCap: ToolCapability = {
    id: 'test-tools',
    initialProgress: options.initialProgress,
    declareTools: () =>
      toolNames.map((name) => ({
        name,
        description: name,
        input_schema: { type: 'object', properties: {} },
      })),
    instructions: (names) => (options.instructions ? options.instructions(names) : null),
    handles: (name) => toolNames.includes(name) || Object.hasOwn(effects, name),
    effectOf: (name) => effects[name] ?? 'session',
    run: async (call, context) => {
      const turn = slice.getTurnSnapshot(context.sessionId, context.replyId)
      const running = turn?.blocks.find(
        (b) => b.type === 'tool_result' && b.tool_use_id === call.id
      )
      runs.push({
        call,
        initialPhase: running?.type === 'tool_result' ? running.progress?.phase : undefined,
        context,
      })
      return runTool(call, context)
    },
    presenter: options.presenter,
    turnHooks: options.turnHooks,
  }

  const tools = createToolRegistry([recordedCap, ...(options.extraCapabilities ?? [])])

  const slice = createTestSlice({
    log,
    store,
    blobs,
    sessions,
    tools,
    autoTitle: options.autoTitle ?? false,
    params: options.params,
    onStreamTrace: (trace) => {
      traces.push(trace)
    },
    fetch: async (url, init) => {
      if (url.endsWith('/files') && init.method === 'POST') {
        const file = (init.body as FormData).get('file') as File
        const index = uploads.push(file.name) - 1
        const answer = await respondToUpload(file.name, index)
        return 'id' in answer
          ? jsonResponse(200, {
              id: answer.id,
              type: 'file',
              size_bytes: file.size,
              created_at: new Date(0).toISOString(),
              filename: file.name,
              mime_type: file.type,
            })
          : jsonResponse(answer.errorStatus, { error: { message: answer.errorMessage } })
      }
      if (/\/files\/[^/]+$/.test(url) && init.method === 'DELETE') {
        return jsonResponse(200, {})
      }
      if (!url.endsWith('/messages')) {
        throw new Error(`unexpected request ${url}`)
      }
      const body = JSON.parse(String(init.body)) as ApiRequest
      requests.push(body)
      const reply = await respond(body, init.signal ?? undefined)
      if ('networkError' in reply) {
        throw new TypeError(reply.networkError)
      }
      if ('errorStatus' in reply) {
        return new Response(JSON.stringify({ error: { message: reply.errorMessage } }), {
          status: reply.errorStatus,
          headers: { 'Content-Type': 'application/json' },
        })
      }
      return sseResponse(toEvents(reply, () => `call${++callCounter}`))
    },
  })

  return {
    slice,
    log,
    blobs,
    sessions,
    tools,
    requests,
    runs,
    traces,
    uploads,
    respondToUploadsWith: (fn: typeof respondToUpload) => {
      respondToUpload = fn
    },
    respondWith: (
      fn: (request: ApiRequest, signal?: AbortSignal) => ApiReply | Promise<ApiReply>
    ) => {
      respond = fn
    },
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

export const say = async (env: StoreEnv, sessionId: string | null, text: string) => {
  env.slice.commands.setDraft(sessionId, text)
  const sent = env.slice.commands.send(sessionId)
  await env.slice.commands.whenIdle()
  return sent
}

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

export const sendWhenUploaded = async (env: StoreEnv, sessionId: string | null) => {
  for (let tries = 0; tries < 200; tries += 1) {
    if (env.slice.commands.send(sessionId)) {
      await env.slice.commands.whenIdle()
      return
    }
    await new Promise((resolve) => setTimeout(resolve, 10))
  }
  throw new Error('the draft never became sendable')
}
