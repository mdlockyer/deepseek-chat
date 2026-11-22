import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import {
  applyEvent,
  canContinueReply,
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
  thinking: true,
  search: false,
  prefix: true,
  status: 'done',
  blocks,
  ...overrides,
})

describe('applyEvent & settleReply', () => {
  it('assembles thinking, tool_use JSON, and text deltas and clears prefix on tool_use', () => {
    const indexes = new Map<number, number>()
    let reply = assistant('a1', [], { status: 'pending', prefix: true })

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

    assert.equal(reply.prefix, false)
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
        {
          type: 'server_tool_use',
          id: 's1',
          name: 'deepseek_web_search',
          input: { action: 'search', query: 'q', queries: ['q'] },
          kind: 'search',
          caller: { type: 'direct' },
        },
      ],
      { status: 'streaming', stopReason: 'refusal' }
    )

    const settled = settleReply(reply, 'done', 50)
    assert.equal(settled.status, 'done')
    assert.equal(settled.blocks.length, 1)
    assert.equal(settled.blocks[0].type, 'server_tool_use')
  })
})

describe('toRequestMessages', () => {
  it('excludes unusable rounds, historical thinking, and unsigned read_link results', () => {
    const history = [
      user('u1', 'q1'),
      assistant('a1', [{ type: 'text', text: 'bad', isTemplate: true }], { status: 'error' }),
      user('u2', 'q2'),
      assistant(
        'a2',
        [
          { type: 'thinking', thinking: 'hidden thought', signature: 'sig' },
          {
            type: 'server_tool_use',
            id: 'r1',
            name: 'deepseek_read_url',
            input: { action: 'read_link', url: 'https://example.com' },
            kind: 'read_link',
            caller: { type: 'direct' },
          },
          {
            type: 'web_fetch_tool_result',
            tool_use_id: 'r1',
            kind: 'read_link',
            content: {
              type: 'web_fetch_result',
              url: 'https://example.com',
              content: {
                type: 'document',
                source: { type: 'text', media_type: 'text/plain', data: '' },
                title: 'Example',
              },
              published_at: null,
            },
            signature: 'signed-payload',
          },
          { type: 'text', text: 'answer 2' },
        ],
        { latestReminder: 'rem-1' }
      ),
    ]

    const messages = toRequestMessages(history, user('u3', 'q3'), undefined, true, 'rem-1')

    assert.deepEqual(messages, [
      { role: 'latest_reminder', content: 'rem-1' },
      { role: 'user', content: 'q2' },
      {
        role: 'assistant',
        content: [
          {
            type: 'server_tool_use',
            id: 'r1',
            name: 'deepseek_read_url',
            input: { action: 'read_link', url: 'https://example.com' },
            kind: 'read_link',
          },
          {
            type: 'web_fetch_tool_result',
            tool_use_id: 'r1',
            kind: 'read_link',
            content: {
              type: 'web_fetch_result',
              url: 'https://example.com',
              content: {
                type: 'document',
                source: { type: 'text', media_type: 'text/plain', data: '' },
                title: 'Example',
              },
              published_at: null,
            },
            signature: 'signed-payload',
          },
          { type: 'text', text: 'answer 2' },
        ],
      },
      { role: 'user', content: 'q3' },
    ])
  })

  it('merges aborted tool_result user turn with the next user question to preserve role alternation', () => {
    const history = [
      user('u1', 'run python'),
      assistant('a1', [
        { type: 'thinking', thinking: 'need python', signature: 'sig-py' },
        { type: 'tool_use', id: 'py1', name: 'python', input: { code: 'print(1)' } },
        { type: 'tool_result', tool_use_id: 'py1', content: '1', status: 'ok' },
        { type: 'text', text: 'before stop' },
      ]),
      user('u2', 'only tool'),
      assistant(
        'a2',
        [
          { type: 'tool_use', id: 'py2', name: 'python', input: { code: 'print(2)' } },
          { type: 'tool_result', tool_use_id: 'py2', content: '2', status: 'ok' },
          { type: 'text', text: 'done' },
        ],
        { status: 'stopped' }
      ),
    ]

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
    assert.equal(history.length, 4)
  })

  it('checks canContinueReply rules for max_tokens, stopped, and tool/template restrictions', () => {
    assert.equal(
      canContinueReply(
        assistant('a1', [{ type: 'text', text: 'cut off' }], {
          status: 'done',
          stopReason: 'max_tokens',
          prefix: true,
        })
      ),
      true
    )
    assert.equal(
      canContinueReply(
        assistant('a2', [{ type: 'text', text: 'template', isTemplate: true }], {
          status: 'stopped',
          prefix: true,
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

    const messages = toRequestMessages(
      history,
      user('u2', 'run python'),
      undefined,
      true,
      undefined,
      undefined,
      new Set(['python'])
    )

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
