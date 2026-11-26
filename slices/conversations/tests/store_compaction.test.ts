import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import {
  ApiError,
  classifyApiError,
  type CreateMessageRequest,
  type MessageStreamEvent,
  type ModelProvider,
  type ModelSpec,
} from '@deepseek-chat/lib-agent'
import { createToolRegistry, type ToolCapability } from '@deepseek-chat/lib-tools'
import { createTestSlice } from './harness.js'

// Hidden page so streaming writes synchronously per event in headless Node tests.
Object.assign(globalThis, {
  document: { visibilityState: 'hidden' },
  requestAnimationFrame: (callback: () => void) => setTimeout(callback, 0),
  cancelAnimationFrame: (id: ReturnType<typeof setTimeout>) => clearTimeout(id),
})

const VALID_SUMMARY = [
  '## Goal',
  'Help the user complete their engineering analysis.',
  '',
  '## Current State',
  'Completed initial checks and recorded verified outcomes.',
  '',
  '## Decisions & Constraints',
  'Keep all constraints intact.',
  '',
  '## Key Findings',
  'Tool outputs were inspected and summarized.',
  '',
  '## Next Steps',
  'Answer the pending request cleanly.',
].join('\n')

const textStream = (
  text: string,
  usage = {
    input_tokens: 200,
    cache_creation_input_tokens: 0,
    cache_read_input_tokens: 0,
    output_tokens: 40,
  }
): MessageStreamEvent[] => [
  { type: 'message_start', message: { id: 'm1', model: 'tiny-16k', usage } },
  { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } },
  { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text } },
  { type: 'content_block_stop', index: 0 },
  {
    type: 'message_delta',
    delta: { stop_reason: 'end_turn', stop_sequence: null },
    usage: { output_tokens: usage.output_tokens },
  },
  { type: 'message_stop' },
]

const toolCallStream = (
  id: string,
  name: string,
  input: Record<string, unknown>,
  thinking?: string,
  usage = {
    input_tokens: 400,
    cache_creation_input_tokens: 0,
    cache_read_input_tokens: 0,
    output_tokens: 60,
  }
): MessageStreamEvent[] => [
  { type: 'message_start', message: { id: `m-${id}`, model: 'tiny-16k', usage } },
  ...(thinking
    ? [
        {
          type: 'content_block_start' as const,
          index: 0,
          content_block: { type: 'thinking' as const, thinking: '', signature: 'sig-x' },
        },
        {
          type: 'content_block_delta' as const,
          index: 0,
          delta: { type: 'thinking_delta' as const, thinking },
        },
        { type: 'content_block_stop' as const, index: 0 },
      ]
    : []),
  {
    type: 'content_block_start',
    index: thinking ? 1 : 0,
    content_block: { type: 'tool_use', id, name, input },
  },
  { type: 'content_block_stop', index: thinking ? 1 : 0 },
  {
    type: 'message_delta',
    delta: { stop_reason: 'tool_use', stop_sequence: null },
    usage: { output_tokens: usage.output_tokens },
  },
  { type: 'message_stop' },
]

const makeTinyProvider = (
  handler: (
    body: CreateMessageRequest,
    signal: AbortSignal,
    callIndex: number
  ) => AsyncIterable<MessageStreamEvent> | Promise<AsyncIterable<MessageStreamEvent>>,
  windowTokens = 16_000
): { provider: ModelProvider; calls: CreateMessageRequest[] } => {
  const calls: CreateMessageRequest[] = []
  const spec: ModelSpec = {
    id: 'tiny-16k',
    provider: 'tiny',
    label: 'Tiny 16K',
    contextWindow: windowTokens,
    maxOutputTokens: 2_048,
    capabilities: {
      thinking: true,
      vision: true,
      documents: true,
      tools: true,
      promptCaching: true,
    },
  }
  const provider: ModelProvider = {
    id: 'tiny',
    label: 'Tiny',
    defaultModel: 'tiny-16k',
    models: [spec],
    isConfigured: () => true,
    modelSpec: () => spec,
    classifyError: classifyApiError,
    streamMessage: async function* (body, signal) {
      const idx = calls.length
      calls.push(structuredClone(body))
      const stream = await handler(body, signal, idx)
      for await (const event of stream) {
        if (signal.aborted) {
          throw new DOMException('Aborted', 'AbortError')
        }
        yield event
      }
    },
  }
  return { provider, calls }
}

async function* emit(events: MessageStreamEvent[]): AsyncGenerator<MessageStreamEvent> {
  for (const event of events) {
    yield event
  }
}

describe('conversations store: compaction triggers (manual, turnStart, betweenRounds, fit, overflow)', () => {
  it('supports manual compaction with capability ledger facts and clean abort without mutating state', async () => {
    const ledgerCap: ToolCapability = {
      id: 'notes',
      declareTools: () => [
        {
          name: 'save_note',
          description: 'Save a note.',
          input_schema: { type: 'object', properties: { title: { type: 'string' } } },
        },
      ],
      instructions: () => null,
      handles: (name) => name === 'save_note',
      effectOf: () => 'artifact',
      run: async () => ({ content: 'Saved note alpha', status: 'ok' }),
      buildCompactionLedger: (entries) => ({
        title: 'Saved notes',
        lines: entries.map(({ call }) => `- Note saved via ${call.name}`),
      }),
    }

    const { provider, calls } = makeTinyProvider((_body, signal, idx) => {
      if (idx === 0) {
        return emit(toolCallStream('tc-1', 'save_note', { title: 'alpha' }))
      }
      if (idx === 1) {
        return emit(textStream('Note alpha saved.'))
      }
      if (idx === 2) {
        // First manual compaction: hang until aborted to verify clean cancellation.
        return new Promise<AsyncIterable<MessageStreamEvent>>((_resolve, reject) => {
          signal.addEventListener(
            'abort',
            () => reject(new DOMException('Aborted', 'AbortError')),
            {
              once: true,
            }
          )
        })
      }
      if (idx === 3) {
        // Second manual compaction: valid structured summary.
        return emit(textStream(VALID_SUMMARY))
      }
      // Follow-up turn after manual compaction.
      return emit(textStream('Continuing seamlessly.'))
    })

    const slice = createTestSlice({
      provider,
      tools: createToolRegistry([ledgerCap]),
      autoTitle: false,
    })
    await slice.commands.init()

    // Turn 1 with tool call.
    slice.commands.setDraft(null, 'Save a note called alpha')
    assert.equal(slice.commands.send(null), true)
    await slice.commands.whenIdle()

    const sessionId = slice.getState().activeId
    assert.ok(sessionId)
    const updatedBefore = slice.getState().sessions[0]?.updatedAt

    // Manual compaction aborted mid-flight: leaves checkpoints empty.
    const cancelTask = slice.commands.compact(sessionId)
    await new Promise((r) => setTimeout(r, 15))
    slice.stopReply(sessionId)
    assert.equal(await cancelTask, 'cancelled')
    assert.equal(slice.getChatCheckpoints(sessionId).length, 0)

    // Manual compaction succeeds: checkpoint stored without touching updatedAt, contains capability ledger.
    assert.equal(await slice.commands.compact(sessionId), 'compacted')
    const checkpoints = slice.getChatCheckpoints(sessionId)
    assert.equal(checkpoints.length, 1)
    assert.equal(checkpoints[0]?.trigger, 'manual')
    assert.match(checkpoints[0]?.renderedWireText ?? '', /Saved notes/)
    assert.match(checkpoints[0]?.renderedWireText ?? '', /Note saved via save_note/)
    assert.equal(slice.getState().sessions[0]?.updatedAt, updatedBefore)

    // Follow-up turn sends frozen checkpoint wire text as messages[0].
    slice.commands.setDraft(sessionId, 'What did we save?')
    assert.equal(slice.commands.send(sessionId), true)
    await slice.commands.whenIdle()

    const followUpReq = calls.at(-1)
    assert.ok(followUpReq)
    assert.equal(followUpReq.messages[0]?.role, 'user')
    assert.equal(followUpReq.messages[0]?.content, checkpoints[0]?.renderedWireText)
    assert.match(String(followUpReq.messages.at(-1)?.content), /What did we save\?/)

    slice.dispose()
  })

  it('auto-compacts on turnStart riding cache, preserves pending question verbatim, and degrades gracefully on bad summary', async () => {
    const notices: string[] = []
    let failSummary = true
    const { provider, calls } = makeTinyProvider((body) => {
      const last = body.messages.at(-1)
      const isCompactionCall =
        last?.role === 'user' &&
        (typeof last.content === 'string'
          ? last.content.includes('From the app harness, not the user:')
          : last.content.some(
              (b) => b.type === 'text' && b.text.includes('From the app harness, not the user:')
            ))
      if (isCompactionCall) {
        if (failSummary) {
          failSummary = false
          return emit(textStream('OK')) // Invalid summary -> must keep old context and continue!
        }
        return emit(textStream(VALID_SUMMARY))
      }
      // Return high usage (12,000 tokens > 11,200 line for 16K window).
      return emit(
        textStream('Reply payload.', {
          input_tokens: 11_800,
          cache_creation_input_tokens: 0,
          cache_read_input_tokens: 0,
          output_tokens: 200,
        })
      )
    })

    const slice = createTestSlice({
      provider,
      autoTitle: false,
      notify: { show: (n) => notices.push(n.text()) },
    })
    await slice.commands.init()

    // Turn 1 sets usage = 12,000 (above the 11,200 line on a 16K window).
    slice.commands.setDraft(null, 'Turn 1 question')
    slice.commands.send(null)
    await slice.commands.whenIdle()
    const sid = slice.getState().activeId
    assert.ok(sid)

    // Turn 2: compaction triggers on turnStart, returns invalid "OK" -> warns & continues with original history!
    slice.commands.setDraft(sid, 'Turn 2 question')
    slice.commands.send(sid)
    await slice.commands.whenIdle()
    assert.equal(slice.getChatCheckpoints(sid).length, 0)
    assert.ok(notices.length >= 1)

    // Turn 3: compaction triggers on turnStart again, now succeeds -> rides cache prefix, preserves Turn 3 verbatim!
    slice.commands.setDraft(sid, 'Turn 3 pending question')
    slice.commands.send(sid)
    await slice.commands.whenIdle()

    const cps = slice.getChatCheckpoints(sid)
    assert.equal(cps.length, 1)
    assert.equal(cps[0]?.trigger, 'turnStart')

    // Compaction call had thinking disabled and rode the prior history prefix (without Turn 3).
    const compactReq = calls.at(-2)
    assert.deepEqual(compactReq?.thinking, { type: 'disabled' })
    assert.equal(JSON.stringify(compactReq?.messages).includes('Turn 3 pending question'), false)

    // Actual Turn 3 request used the frozen checkpoint and preserved Turn 3 verbatim.
    const turn3Req = calls.at(-1)
    assert.equal(turn3Req?.messages[0]?.content, cps[0]?.renderedWireText)
    assert.match(String(turn3Req?.messages.at(-1)?.content), /Turn 3 pending question/)

    slice.dispose()
  })

  it('auto-compacts mid-turn between tool rounds, drops pre-checkpoint reasoning, and finishes the turn', async () => {
    const bigTool: ToolCapability = {
      id: 'big-read',
      declareTools: () => [
        {
          name: 'read_huge',
          description: 'Read huge payload.',
          input_schema: { type: 'object', properties: {} },
        },
      ],
      instructions: () => null,
      handles: (name) => name === 'read_huge',
      effectOf: () => 'read',
      run: async () => ({
        content: 'data '.repeat(6_000), // ~7.5K tokens; combined with 5K usage crosses 11.2K line!
        status: 'ok',
      }),
    }

    const { provider, calls } = makeTinyProvider((body, _signal, idx) => {
      if (idx === 0) {
        return emit(
          toolCallStream('tc-big', 'read_huge', {}, 'hidden pre-checkpoint thought', {
            input_tokens: 5_000,
            cache_creation_input_tokens: 0,
            cache_read_input_tokens: 0,
            output_tokens: 100,
          })
        )
      }
      const last = body.messages.at(-1)
      const isCompact =
        last?.role === 'user' &&
        JSON.stringify(last.content).includes('From the app harness, not the user:')
      if (isCompact) {
        return emit(textStream(VALID_SUMMARY))
      }
      return emit(textStream('Finished after mid-turn compaction.'))
    })

    const slice = createTestSlice({
      provider,
      tools: createToolRegistry([bigTool]),
      autoTitle: false,
    })
    slice.setThinking(true)
    await slice.commands.init()

    slice.commands.setDraft(null, 'Inspect the huge log')
    slice.commands.send(null)
    await slice.commands.whenIdle()

    const sid = slice.getState().activeId
    assert.ok(sid)
    const cps = slice.getChatCheckpoints(sid)
    assert.equal(cps.length, 1)
    assert.equal(cps[0]?.trigger, 'betweenRounds')
    assert.equal(cps[0]?.droppedReasoning, true)
    assert.equal(typeof cps[0]?.afterBlockIndex, 'number')

    // Round 2 request started directly from the mid-turn checkpoint without replaying pre-checkpoint thinking.
    const round2Req = calls.at(-1)
    assert.ok(round2Req)
    assert.equal(round2Req.messages[0]?.content, cps[0]?.renderedWireText)
    assert.equal(
      JSON.stringify(round2Req.messages).includes('hidden pre-checkpoint thought'),
      false
    )

    const visible = slice.getChatMessages(sid)
    const reply = visible.at(-1)
    assert.equal(reply?.role, 'assistant')
    assert.equal(reply.status, 'done')

    slice.dispose()
  })

  it('recovers reactively on HTTP 400 contextOverflow / 413 payloadTooLarge via chunked fallback and never loops infinitely', async () => {
    let overflowCount = 0
    const { provider } = makeTinyProvider((body) => {
      const text = JSON.stringify(body.messages)
      const isChunkOrCompact = text.includes('From the app harness, not the user:')
      if (isChunkOrCompact) {
        // Reject cache-riding compaction with 413 to prove automatic fallback to chunked plain-text fold!
        if (body.messages.length > 1) {
          throw new ApiError('http', 'Request payload too large', 413)
        }
        return emit(textStream(VALID_SUMMARY))
      }
      const lastText = JSON.stringify(body.messages.at(-1)?.content ?? '')
      // Turn 3: always throws 400 overflow even after compaction -> must stop after 1 retry (no infinite loop!).
      if (lastText.includes('Always overflow')) {
        overflowCount += 1
        throw new ApiError('http', 'prompt is too long', 400)
      }
      // Turn 2: first attempt throws 400 context overflow; retry with checkpoint succeeds!
      if (lastText.includes('Trigger overflow')) {
        if (!text.includes('<conversation_checkpoint>')) {
          overflowCount += 1
          throw new ApiError('http', "This model's maximum context length is 16000 tokens.", 400)
        }
        return emit(textStream('Recovered after overflow compaction!'))
      }
      // Turn 1 succeeds normally.
      return emit(textStream('Initial answer.'))
    })

    const slice = createTestSlice({ provider, autoTitle: false })
    await slice.commands.init()

    slice.commands.setDraft(null, 'Turn 1 setup')
    slice.commands.send(null)
    await slice.commands.whenIdle()
    const sid = slice.getState().activeId
    assert.ok(sid)

    // Turn 2: hits 400 -> cache-riding hits 413 -> chunked fold succeeds -> retries once -> reply done!
    slice.commands.setDraft(sid, 'Trigger overflow now')
    slice.commands.send(sid)
    await slice.commands.whenIdle()

    const cpsAfterT2 = slice.getChatCheckpoints(sid)
    assert.equal(cpsAfterT2.length, 1)
    assert.equal(cpsAfterT2[0]?.trigger, 'overflow')
    const reply2 = slice.getChatMessages(sid).at(-1)
    assert.equal(reply2?.role, 'assistant')
    assert.equal(reply2.status, 'done')

    // Turn 3: overflows both before and after compaction -> retries exactly once, then settles error!
    const beforeOverflowCount = overflowCount
    slice.commands.setDraft(sid, 'Always overflow request')
    slice.commands.send(sid)
    await slice.commands.whenIdle()

    assert.equal(overflowCount - beforeOverflowCount, 2)
    const reply3 = slice.getChatMessages(sid).at(-1)
    assert.equal(reply3?.role, 'assistant')
    assert.equal(reply3.status, 'error')

    slice.dispose()
  })
})
