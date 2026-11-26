import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import {
  ApiError,
  classifyApiError,
  type CreateMessageRequest,
  type MessageStreamEvent,
  type ModelProvider,
} from '@deepseek-chat/lib-agent'
import { createToolRegistry, type ToolCapability } from '@deepseek-chat/lib-tools'
import { memoryBlobStore, memoryStore } from '@deepseek-chat/spine/ports'
import { EventLog } from '@deepseek-chat/spine/runtime'
import {
  CONTINUE_PROMPT,
  createConversationsSlice,
  memorySessionStore,
  type AssistantMessage,
} from '@deepseek-chat/slice-conversations'

// Hidden page so streaming writes synchronously per event.
Object.assign(globalThis, {
  document: { visibilityState: 'hidden' },
  requestAnimationFrame: (callback: () => void) => setTimeout(callback, 0),
  cancelAnimationFrame: (id: ReturnType<typeof setTimeout>) => clearTimeout(id),
})

const flushAsync = async () => {
  for (let i = 0; i < 12; i += 1) {
    await new Promise((resolve) => setTimeout(resolve, 0))
  }
}

const textEvents = (
  text: string,
  stopReason: 'end_turn' | 'max_tokens' = 'end_turn',
  outputTokens = 12
): MessageStreamEvent[] => [
  {
    type: 'message_start',
    message: {
      id: 'acme-msg',
      model: 'acme-chat-1',
      usage: {
        input_tokens: 40,
        cache_creation_input_tokens: 0,
        cache_read_input_tokens: 0,
        output_tokens: 0,
      },
    },
  },
  { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } },
  { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text } },
  { type: 'content_block_stop', index: 0 },
  // Partial Anthropic-style delta usage (only output_tokens, no cache fields).
  {
    type: 'message_delta',
    delta: { stop_reason: stopReason, stop_sequence: null },
    usage: { output_tokens: outputTokens },
  },
  { type: 'message_stop' },
]

const toolCallEvents = (id: string, name: string, input: unknown): MessageStreamEvent[] => [
  {
    type: 'message_start',
    message: {
      id: 'acme-tool',
      model: 'acme-chat-1',
      usage: {
        input_tokens: 50,
        cache_creation_input_tokens: 0,
        cache_read_input_tokens: 0,
        output_tokens: 0,
      },
    },
  },
  {
    type: 'content_block_start',
    index: 0,
    content_block: { type: 'tool_use', id, name, input: {} },
  },
  {
    type: 'content_block_delta',
    index: 0,
    delta: { type: 'input_json_delta', partial_json: JSON.stringify(input) },
  },
  { type: 'content_block_stop', index: 0 },
  {
    type: 'message_delta',
    delta: { stop_reason: 'tool_use', stop_sequence: null },
    usage: { output_tokens: 9 },
  },
  { type: 'message_stop' },
]

describe('conversations: provider-neutral boundary proof (synthetic inline-base64 provider)', () => {
  it('runs multi-turn chat, inline base64 files, inline tool screenshots, Continue, auto-title, and overflow errors without DeepSeek specifics', async () => {
    const seenRequests: CreateMessageRequest[] = []
    let handler: (req: CreateMessageRequest) => MessageStreamEvent[] | Error = () =>
      textEvents('ok')

    const acmeModel = {
      id: 'acme-chat-1',
      provider: 'acme' as const,
      label: 'Acme Chat 1',
      contextWindow: 200_000,
      maxOutputTokens: 16_384,
      capabilities: {
        thinking: true,
        vision: true,
        documents: true,
        tools: true,
        promptCaching: true,
      },
    }

    const acmeProvider: ModelProvider = {
      id: 'acme',
      label: 'Acme',
      defaultModel: 'acme-chat-1',
      models: [acmeModel],
      isConfigured: () => true,
      modelSpec: () => acmeModel,
      classifyError: classifyApiError,
      // Explicitly NO remote attachments port: files and tool screenshots must travel inline as base64.
      attachments: undefined,
      streamMessage: async function* (body) {
        seenRequests.push(structuredClone(body))
        const result = handler(body)
        if (result instanceof Error) {
          throw result
        }
        for (const event of result) {
          yield event
        }
      },
    }

    const screenshotCap: ToolCapability = {
      id: 'snap-cap',
      declareTools: () => [
        {
          name: 'take_snap',
          description: 'Capture a screenshot.',
          input_schema: { type: 'object', properties: {} },
        },
      ],
      instructions: () => null,
      handles: (name) => name === 'take_snap',
      effectOf: () => 'read',
      run: async () => ({
        content: 'Captured frame.',
        status: 'ok',
        images: ['data:image/png;base64,iVBORw0KGgo='],
      }),
    }

    const slice = createConversationsSlice({
      log: new EventLog(),
      provider: acmeProvider,
      store: memoryStore(),
      blobs: memoryBlobStore(),
      sessions: memorySessionStore(),
      tools: createToolRegistry([screenshotCap]),
      platform: 'web',
      getLocationLabel: () => 'Seattle',
      autoTitle: true,
      ui: {
        voice: null,
        openSettings: () => {},
        openInApp: null,
        saveFile: async () => {},
        setSiderCollapsed: () => {},
      },
    })

    await slice.commands.init()

    const isTitleFork = (req: CreateMessageRequest) => {
      const last = req.messages.at(-1)
      return (
        last?.role === 'user' &&
        typeof last.content === 'string' &&
        last.content.includes('Do not call any tools.')
      )
    }

    // Turn 1: attach a document + image (inline base64), trigger a tool screenshot, and auto-title.
    let turn1Step = 0
    handler = (req) => {
      if (isTitleFork(req)) {
        return textEvents('Acme Screenshot Review')
      }
      turn1Step += 1
      if (turn1Step === 1) {
        return toolCallEvents('call-snap', 'take_snap', {})
      }
      return textEvents('First part ', 'max_tokens', 21)
    }

    const docFile = new File(['hello acme'], 'brief.txt', { type: 'text/plain' })
    const imgFile = new File([new Uint8Array([1, 2, 3])], 'pic.png', { type: 'image/png' })
    assert.equal(slice.commands.attach(null, [docFile, imgFile]), null)
    slice.commands.setDraft(null, 'Inspect these files')
    // Inline providers mark attachments ready immediately with zero network upload wait.
    assert.equal(slice.commands.send(null), true)
    await slice.commands.whenIdle()
    await flushAsync()

    const sessionId = slice.getState().activeId
    assert.ok(sessionId)

    // Verify Turn 1 main request used Acme model, standard roles, inline base64 files, and <environment_context>.
    const req1 = seenRequests[0]
    assert.ok(req1)
    assert.equal(req1.model, 'acme-chat-1')
    assert.equal(req1.messages.length, 1)
    assert.equal(req1.messages[0]?.role, 'user')
    assert.ok(Array.isArray(req1.messages[0]?.content))
    const userBlocks = req1.messages[0].content as {
      type: string
      text?: string
      source?: { type: string; media_type?: string; data?: string }
    }[]
    assert.match(userBlocks[0]?.text ?? '', /^<environment_context>[\s\S]*Seattle/)
    assert.deepEqual(userBlocks[1], {
      type: 'document',
      source: { type: 'base64', media_type: 'text/plain', data: btoa('hello acme') },
    })
    assert.deepEqual(userBlocks[2], {
      type: 'image',
      source: { type: 'base64', media_type: 'image/png', data: btoa(String.fromCharCode(1, 2, 3)) },
    })
    assert.deepEqual(userBlocks[3], { type: 'text', text: 'Inspect these files' })

    // Verify Tool round follow-up inlined the screenshot as base64 (not file_id).
    const req2 = seenRequests[1]
    assert.ok(req2)
    const toolResultMsg = req2.messages.at(-1)
    assert.equal(toolResultMsg?.role, 'user')
    assert.ok(Array.isArray(toolResultMsg?.content))
    assert.ok(
      (toolResultMsg.content as { type: string; source?: { type: string; data?: string } }[]).some(
        (b) => b.type === 'image' && b.source?.type === 'base64' && b.source.data === 'iVBORw0KGgo='
      ),
      'tool screenshot traveled inline as base64'
    )

    // Verify Turn 1 auto-title named the session and merged partial usage cleanly.
    assert.equal(
      slice.getState().sessions.find((s) => s.id === sessionId)?.title,
      'Acme Screenshot Review'
    )
    const reply1 = slice.getChatMessages(sessionId).at(-1) as AssistantMessage
    assert.equal(reply1.model, 'acme-chat-1')
    assert.equal(reply1.provider, 'acme')
    assert.equal(reply1.stopReason, 'max_tokens')
    assert.equal(reply1.usage?.input_tokens, 40)
    assert.equal(reply1.usage?.output_tokens, 21)

    // Continue the max_tokens reply: must send standard user CONTINUE_PROMPT (no assistant prefill)
    // and append the continuation into the SAME reply bubble.
    const beforeContinue = seenRequests.length
    handler = (req) =>
      isTitleFork(req) ? textEvents('KEEP') : textEvents('and finished.', 'end_turn')
    slice.commands.continueReply(sessionId, reply1.id)
    await slice.commands.whenIdle()
    await flushAsync()

    const continueReq = seenRequests[beforeContinue]
    assert.ok(continueReq)
    assert.equal(continueReq.messages.at(-1)?.role, 'user')
    assert.equal(continueReq.messages.at(-1)?.content, CONTINUE_PROMPT)
    const continuedReply = slice.getChatMessages(sessionId).at(-1) as AssistantMessage
    assert.equal(continuedReply.id, reply1.id)
    assert.equal(continuedReply.status, 'done')
    assert.equal(
      continuedReply.blocks.flatMap((b) => (b.type === 'text' ? [b.text] : [])).join(''),
      'First part and finished.'
    )

    // Turn 2: context overflow error maps to localized notice via classifyError.
    handler = () => new ApiError('http', 'prompt is too long: 210000 tokens > 200000 maximum', 400)
    slice.commands.setDraft(sessionId, 'One more huge message')
    assert.equal(slice.commands.send(sessionId), true)
    await slice.commands.whenIdle()

    const overflowReply = slice.getChatMessages(sessionId).at(-1) as AssistantMessage
    assert.equal(overflowReply.status, 'error')
    const notice = slice.describeReplyNotice(overflowReply)
    assert.ok(notice && /context|上下文/.test(notice), `unexpected overflow notice: ${notice}`)

    // Verify ZERO requests ever contained proprietary wire fields or roles.
    for (const req of seenRequests) {
      assert.equal('title' in req, false)
      assert.equal('safety_check' in req, false)
      for (const msg of req.messages) {
        assert.ok(msg.role === 'user' || msg.role === 'assistant')
      }
    }

    slice.dispose()
  })
})
