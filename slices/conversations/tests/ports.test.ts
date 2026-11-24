import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { memoryStore } from '@deepseek-chat/spine/ports'
import {
  buildReplyView,
  readSessionFile,
  setBrowser,
  setThinking,
  toLocalSession,
  toSessionFile,
  useComposerOptions,
  type AssistantMessage,
  type Session,
  type ToolKind,
} from '@deepseek-chat/slice-conversations'
import { installTestSlice } from './harness.js'

// Names deliberately unlike the real tools: classification must come from the gateway alone.
const KINDS: Record<string, ToolKind> = {
  find_web: 'web_search',
  make_doc: 'present_file',
  run_code: 'python',
}
const store = memoryStore({ 'chat-demo:search': 'true', 'chat-demo:python': 'false' })
const slice = installTestSlice({
  store,
  tools: {
    declare: () => [],
    instructions: () => [],
    describe: () => null,
    kindOf: (name) => KINDS[name] ?? null,
    effectOf: (name) => (KINDS[name] === 'web_search' ? 'read' : 'session'),
    agentProfile: () => null,
    fenceLanguage: (path) => (path.endsWith('.lisp') ? 'lisp' : 'text'),
    run: async () => ({ content: '', status: 'ok' }),
  },
})

const reply = (blocks: AssistantMessage['blocks']): AssistantMessage => ({
  id: 'a1',
  role: 'assistant',
  createdAt: 2_000,
  model: null,
  prefix: false,
  status: 'done',
  blocks,
})

describe('conversations: one instance per app', () => {
  it('refuses to be created twice', () => {
    assert.equal(typeof slice.stopReply, 'function')
    assert.throws(() => installTestSlice(), /created once per app/)
  })
})

describe('conversations: composer toggles', () => {
  it('load from the store and save each change under its chat-demo key', () => {
    assert.deepEqual(useComposerOptions.getState(), {
      thinking: false,
      search: true,
      python: false,
      browser: false,
    })
    setThinking(true)
    setBrowser(true)
    assert.equal(store.get('chat-demo:thinking'), 'true')
    assert.equal(store.get('chat-demo:browser'), 'true')
    assert.equal(useComposerOptions.getState().thinking, true)
    setThinking(false)
    assert.equal(store.get('chat-demo:thinking'), 'false')
  })
})

describe('conversations: tool steps follow the gateway', () => {
  it('shows a call classified as web_search as a search step with its results', () => {
    const view = buildReplyView(
      reply([
        { type: 'tool_use', id: 't1', name: 'find_web', input: { query: 'ssa' } },
        {
          type: 'tool_result',
          tool_use_id: 't1',
          content: 'ok',
          status: 'ok',
          searchResults: [
            {
              url: 'https://a.example/',
              title: 'A',
              snippet: 's',
              siteName: null,
              publishedAt: null,
            },
          ],
        },
      ]),
      false
    )
    const step = view.steps[0]
    assert.equal(step?.type, 'search')
    assert.deepEqual(step?.type === 'search' ? step.queries : null, ['ssa'])
    assert.deepEqual(
      view.searchResults.map((source) => source.url),
      ['https://a.example/']
    )
  })

  it('shows the real web tool name as code when the gateway does not classify it', () => {
    const view = buildReplyView(
      reply([{ type: 'tool_use', id: 't1', name: 'web_search', input: { query: 'ssa' } }]),
      false
    )
    assert.equal(view.steps[0]?.type, 'python')
  })

  it('archives a presented file with the gateway fence language', () => {
    const session: Session = {
      id: 's1',
      title: 'T',
      createdAt: 1_000,
      updatedAt: 2_000,
      messages: [
        { id: 'u1', role: 'user', content: 'q', files: [], createdAt: 1_000 },
        {
          ...reply([
            {
              type: 'tool_use',
              id: 'p1',
              name: 'make_doc',
              input: { path: 'core.lisp', content: '(+ 1 2)' },
            },
            { type: 'tool_result', tool_use_id: 'p1', content: 'ok', status: 'ok' },
          ]),
          parentId: 'u1',
        },
      ],
    } as Session
    const local = toLocalSession(readSessionFile(toSessionFile(session, () => null)))
    const text =
      local.session.messages[1]?.role === 'assistant'
        ? local.session.messages[1].blocks
            .flatMap((block) => (block.type === 'text' ? [block.text] : []))
            .join('\n')
        : ''
    assert.match(text, /```lisp\n\(\+ 1 2\)\n```/)
  })
})
