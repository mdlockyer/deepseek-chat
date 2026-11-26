import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import {
  CONTINUE_PROMPT,
  applyEvent,
  canContinueReply,
  formatLegacyLatestReminder,
  pickImageResults,
  settleReply,
  toRequestMessages,
  type AssistantMessage,
  type UserMessage,
} from '@deepseek-chat/slice-conversations'

const user = (id: string, content: string, files: UserMessage['files'] = []): UserMessage => ({
  id,
  role: 'user',
  content,
  files,
  createdAt: 1_000,
})

const assistant = (
  id: string,
  blocks: AssistantMessage['blocks'],
  overrides: Partial<AssistantMessage> = {}
): AssistantMessage => ({
  id,
  role: 'assistant',
  createdAt: 2_000,
  model: 'deepseek-flash',
  provider: 'deepseek',
  thinking: true,
  status: 'done',
  blocks,
  ...overrides,
})

describe('applyEvent & settleReply', () => {
  it('assembles thinking, tool_use JSON, and text deltas', () => {
    const indexes = new Map<number, number>()
    let reply = assistant('a1', [], { status: 'pending' })

    reply = applyEvent(
      reply,
      {
        type: 'content_block_start',
        index: 0,
        content_block: { type: 'thinking', thinking: '', signature: '' },
      },
      100,
      indexes
    )
    reply = applyEvent(
      reply,
      {
        type: 'content_block_delta',
        index: 0,
        delta: { type: 'thinking_delta', thinking: 'step 1' },
      },
      110,
      indexes
    )
    reply = applyEvent(
      reply,
      {
        type: 'content_block_delta',
        index: 0,
        delta: { type: 'signature_delta', signature: 'sig-1' },
      },
      120,
      indexes
    )
    reply = applyEvent(reply, { type: 'content_block_stop', index: 0 }, 150, indexes)
    reply = applyEvent(
      reply,
      {
        type: 'content_block_start',
        index: 1,
        content_block: { type: 'tool_use', id: 'tool-1', name: 'python', input: {} },
      },
      160,
      indexes
    )
    reply = applyEvent(
      reply,
      {
        type: 'content_block_delta',
        index: 1,
        delta: { type: 'input_json_delta', partial_json: '{"code":"1+1"}' },
      },
      170,
      indexes
    )
    reply = applyEvent(reply, { type: 'content_block_stop', index: 1 }, 180, indexes)

    assert.deepEqual(reply.blocks, [
      {
        type: 'thinking',
        thinking: 'step 1',
        signature: 'sig-1',
        startedAt: 100,
        endedAt: 150,
      },
      {
        type: 'tool_use',
        id: 'tool-1',
        name: 'python',
        input: { code: '1+1' },
      },
    ])
  })

  it('drops thinking and text blocks when settled with refusal stopReason', () => {
    const reply = assistant(
      'a1',
      [
        { type: 'thinking', thinking: 'secret', startedAt: 10 },
        { type: 'text', text: 'partial answer' },
        { type: 'tool_use', id: 't1', name: 'web_search', input: { query: 'q' } },
      ],
      { status: 'streaming', stopReason: 'refusal' }
    )

    const settled = settleReply(reply, 'done', 50)
    assert.equal(settled.status, 'done')
    assert.equal(settled.blocks.length, 1)
    assert.equal(settled.blocks[0].type, 'tool_use')
  })
})

describe('toRequestMessages', () => {
  it('excludes unusable rounds and historical thinking, and prepends <environment_context> only when changed', () => {
    const env1 =
      '<environment_context>\nDate: 2026-05-01 (Friday)\nPlatform: Web browser\nLanguage: English\n</environment_context>'
    const env2 =
      '<environment_context>\nDate: 2026-05-02 (Saturday)\nPlatform: Web browser\nLanguage: English\n</environment_context>'
    const history = [
      user('u1', 'q1'),
      assistant('a1', [{ type: 'text', text: 'bad', isTemplate: true }], { status: 'error' }),
      user('u2', 'q2'),
      assistant(
        'a2',
        [
          { type: 'thinking', thinking: 'hidden thought', signature: 'sig' },
          { type: 'text', text: 'answer 2' },
        ],
        { environmentContext: env1 }
      ),
      user('u3', 'q3'),
      assistant('a3', [{ type: 'text', text: 'answer 3' }], { environmentContext: env1 }),
    ]

    const sameEnv = toRequestMessages(history, user('u4', 'q4'), { environmentContext: env1 })
    assert.deepEqual(sameEnv, [
      { role: 'user', content: `${env1}\n\nq2` },
      { role: 'assistant', content: [{ type: 'text', text: 'answer 2' }] },
      { role: 'user', content: 'q3' },
      { role: 'assistant', content: [{ type: 'text', text: 'answer 3' }] },
      { role: 'user', content: 'q4' },
    ])
    assert.equal(
      sameEnv.every((m) => m.role === 'user' || m.role === 'assistant'),
      true,
      'emits only standard user/assistant roles'
    )

    const changedEnv = toRequestMessages(history, user('u4', 'q4'), { environmentContext: env2 })
    assert.equal(changedEnv.at(-1)?.content, `${env2}\n\nq4`)
  })

  it('converts legacy persisted latestReminder CSV into <environment_context>', () => {
    const legacyCsv = '2026-04-12,Sunday,San Francisco,App,English'
    const formatted = formatLegacyLatestReminder(legacyCsv)
    assert.match(formatted, /^<environment_context>/)
    assert.match(formatted, /Date: 2026-04-12 \(Sunday\)/)
    assert.match(formatted, /Platform: Desktop app/)
    assert.match(formatted, /Location: San Francisco/)

    const history = [
      user('u1', 'hello'),
      assistant('a1', [{ type: 'text', text: 'hi' }], { latestReminder: legacyCsv }),
    ]
    const messages = toRequestMessages(history, user('u2', 'next'), {
      environmentContext: formatted,
    })
    assert.equal(messages[0]?.role, 'user')
    assert.equal(messages[0]?.content, `${formatted}\n\nhello`)
    assert.equal(messages[2]?.content, 'next')
  })

  it('strips historical thinking even on tool turns, and replays in-progress thinking only when gated on', () => {
    const history = [
      user('u1', 'run python'),
      assistant('a1', [
        { type: 'thinking', thinking: 'old thought', signature: 'sig-old' },
        { type: 'tool_use', id: 'py1', name: 'python', input: { code: 'print(1)' } },
        { type: 'tool_result', tool_use_id: 'py1', content: '1', status: 'ok' },
        { type: 'text', text: 'Output is 1.' },
      ]),
    ]
    const inProgress = assistant(
      'a2',
      [
        { type: 'thinking', thinking: 'active thought', signature: 'sig-live' },
        { type: 'tool_use', id: 'py2', name: 'python', input: { code: 'print(2)' } },
        { type: 'tool_result', tool_use_id: 'py2', content: '2', status: 'ok' },
      ],
      { status: 'streaming' }
    )

    const withLiveThinking = toRequestMessages(history, user('u2', 'again'), {
      inProgress,
      includeInProgressThinking: true,
    })
    // Historical assistant turn (index 1) has NO thinking block.
    const historicalAssistant = withLiveThinking[1]
    assert.equal(historicalAssistant?.role, 'assistant')
    assert.equal(
      Array.isArray(historicalAssistant.content) &&
        historicalAssistant.content.some((b) => b.type === 'thinking'),
      false
    )
    // Active in-progress assistant turn (index 5) DOES carry its thinking block.
    const activeAssistant = withLiveThinking[5]
    assert.equal(activeAssistant?.role, 'assistant')
    assert.equal(
      Array.isArray(activeAssistant.content) &&
        activeAssistant.content.some(
          (b) => b.type === 'thinking' && b.thinking === 'active thought'
        ),
      true
    )

    // When model/provider changed mid-turn, includeInProgressThinking=false strips active thinking too.
    const withoutLiveThinking = toRequestMessages(history, user('u2', 'again'), {
      inProgress,
      includeInProgressThinking: false,
    })
    const activeStripped = withoutLiveThinking[5]
    assert.equal(activeStripped?.role, 'assistant')
    assert.equal(
      Array.isArray(activeStripped.content) &&
        activeStripped.content.some((b) => b.type === 'thinking'),
      false
    )
  })

  it('merges aborted tool_result user turn with the next user question to preserve role alternation', () => {
    const interruptedHistory = [
      user('u1', 'first'),
      assistant('a1', [
        { type: 'text', text: 'preliminary' },
        { type: 'tool_use', id: 'py1', name: 'python', input: { code: 'x = 1' } },
        { type: 'tool_result', tool_use_id: 'py1', content: '(no output)', status: 'ok' },
      ]),
    ]
    const messages = toRequestMessages(interruptedHistory, user('u2', 'follow up'))

    assert.equal(messages[0]?.role, 'user')
    assert.equal(messages[1]?.role, 'assistant')
    assert.equal(messages[2]?.role, 'user')
    assert.ok(Array.isArray(messages[2]?.content))
    assert.deepEqual(messages[2].content, [
      { type: 'tool_result', tool_use_id: 'py1', content: '(no output)' },
      { type: 'text', text: 'follow up' },
    ])
    assert.equal(messages.length, 3)
  })

  it('emits partial assistant reply plus standard user CONTINUE_PROMPT when continuing prose', () => {
    const partial = assistant(
      'a1',
      [
        { type: 'thinking', thinking: 'internal thought', signature: 'sig' },
        { type: 'text', text: 'First half of the answer' },
      ],
      { status: 'done', stopReason: 'max_tokens' }
    )
    const messages = toRequestMessages([], user('u1', 'write an essay'), {
      continueReply: partial,
    })

    assert.deepEqual(messages, [
      { role: 'user', content: 'write an essay' },
      { role: 'assistant', content: [{ type: 'text', text: 'First half of the answer' }] },
      { role: 'user', content: CONTINUE_PROMPT },
    ])
    assert.equal(messages.at(-1)?.role, 'user', 'continuation never ends on an assistant prefill')
  })

  it('checks canContinueReply rules for max_tokens (including after tools), stopped, and template restrictions', () => {
    assert.equal(
      canContinueReply(
        assistant('a1', [{ type: 'text', text: 'cut off' }], {
          status: 'done',
          stopReason: 'max_tokens',
        })
      ),
      true
    )
    assert.equal(
      canContinueReply(
        assistant(
          'a1-tools',
          [
            { type: 'tool_use', id: 't1', name: 'python', input: {} },
            { type: 'tool_result', tool_use_id: 't1', content: '42', status: 'ok' },
            { type: 'text', text: 'cut off after tool' },
          ],
          { status: 'done', stopReason: 'max_tokens' }
        )
      ),
      true
    )
    assert.equal(
      canContinueReply(
        assistant('a2', [{ type: 'text', text: 'template', isTemplate: true }], {
          status: 'stopped',
        })
      ),
      false
    )
  })

  it('filters historical client tool calls not present in the declared tool set', () => {
    const history = [
      user('u1', 'search this'),
      assistant('a1', [
        { type: 'thinking', thinking: 'will search', signature: 'sig-s' },
        { type: 'tool_use', id: 'ws1', name: 'web_search', input: { query: 'hello' } },
        { type: 'tool_result', tool_use_id: 'ws1', content: 'result', status: 'ok' },
        { type: 'text', text: 'Here is the answer.' },
      ]),
    ]

    const messages = toRequestMessages(history, user('u2', 'run python'), {
      clientTools: new Set(['python']),
    })

    assert.deepEqual(messages, [
      { role: 'user', content: 'search this' },
      { role: 'assistant', content: [{ type: 'text', text: 'Here is the answer.' }] },
      { role: 'user', content: 'run python' },
    ])
  })
})

describe('pickImageResults', () => {
  it('picks newest tool_result image batches within the 12-image budget without splitting', () => {
    const imgs = (n: number) => Array.from({ length: n }, (_, i) => `data:image/jpeg;base64,${i}`)
    const picked = pickImageResults([
      { type: 'tool_result', tool_use_id: 't1', content: '', status: 'ok', images: imgs(5) },
      { type: 'tool_result', tool_use_id: 't2', content: '', status: 'ok', images: imgs(8) },
      { type: 'tool_result', tool_use_id: 't3', content: '', status: 'ok', images: imgs(4) },
    ])
    // Newest t3 (4) + t2 (8) = 12 fits; t1 (5) would exceed 12.
    assert.deepEqual(
      picked.map((b) => b.tool_use_id),
      ['t3', 't2']
    )
  })
})
