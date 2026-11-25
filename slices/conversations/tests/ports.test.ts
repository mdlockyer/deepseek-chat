import 'fake-indexeddb/auto'
import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { createToolRegistry, type ToolCapability } from '@deepseek-chat/lib-tools'
import { memoryStore } from '@deepseek-chat/spine/ports'
import {
  buildReplyView,
  createIndexedDbSessionStore,
  type AssistantMessage,
} from '@deepseek-chat/slice-conversations'
import { createTestSlice } from './harness.js'

const reply = (blocks: AssistantMessage['blocks']): AssistantMessage => ({
  id: 'a1',
  role: 'assistant',
  createdAt: 2_000,
  model: null,
  prefix: false,
  status: 'done',
  blocks,
})

describe('conversations: multi-instance isolation & dispose', () => {
  it('supports multiple isolated instances in the same process without cross-talk', async () => {
    const storeA = memoryStore({ 'chat-demo:thinking': 'true' })
    const storeB = memoryStore({ 'chat-demo:thinking': 'false' })
    const sliceA = createTestSlice({ store: storeA })
    const sliceB = createTestSlice({ store: storeB })

    assert.equal(sliceA.getThinking(), true)
    assert.equal(sliceB.getThinking(), false)

    sliceA.setThinking(false)
    sliceB.setThinking(true)
    assert.equal(storeA.get('chat-demo:thinking'), 'false')
    assert.equal(storeB.get('chat-demo:thinking'), 'true')
    assert.equal(sliceA.getThinking(), false)
    assert.equal(sliceB.getThinking(), true)

    await sliceA.commands.init()
    await sliceB.commands.init()
    await sliceA.replaceSessions(async () => ({
      sessions: [
        {
          id: 'only-in-a',
          title: 'Session A',
          createdAt: 1,
          updatedAt: 1,
          messages: [],
          rootMessageId: null,
        },
      ],
      blobs: [],
    }))
    assert.deepEqual(
      sliceA.getState().sessions.map((s) => s.id),
      ['only-in-a']
    )
    assert.deepEqual(sliceB.getState().sessions, [])

    sliceA.dispose()
    sliceB.dispose()
  })
})

describe('conversations: tool presentation delegates to ToolRegistry', () => {
  it('summarizes tool steps through the owning capability presenter and stays generic without one', () => {
    const customCap: ToolCapability = {
      id: 'calc',
      declareTools: () => [],
      instructions: () => null,
      handles: (name) => name === 'compute_sum',
      effectOf: () => 'read',
      run: async () => ({ content: '42', status: 'ok' }),
      presenter: {
        summarize: (_call, result) => ({
          lane: 'math',
          liveVerb: 'Computing',
          detail: result?.content ?? 'working',
          tally: { key: 'math', count: 1, label: (n) => `${n} calc` },
        }),
        renderActivity: () => null,
      },
    }
    const registry = createToolRegistry([customCap])
    const view = buildReplyView(
      reply([
        { type: 'tool_use', id: 'c1', name: 'compute_sum', input: { a: 20, b: 22 } },
        { type: 'tool_result', tool_use_id: 'c1', capability: 'calc', content: '42', status: 'ok' },
        { type: 'tool_use', id: 'c2', name: 'unknown_tool', input: {} },
      ]),
      false,
      registry
    )

    assert.equal(view.steps[0]?.type, 'tool')
    if (view.steps[0]?.type === 'tool') {
      assert.equal(view.steps[0].summary?.lane, 'math')
      assert.equal(view.steps[0].summary?.detail, '42')
    }
    assert.equal(view.steps[1]?.type, 'tool')
    if (view.steps[1]?.type === 'tool') {
      assert.equal(view.steps[1].summary, null)
    }
  })
})

describe('conversations: IndexedDB session store', () => {
  it('saves, renames, reloads, and deletes sessions with orphaned blob detection', async () => {
    const store = createIndexedDbSessionStore(`deepseek-sessions-test-${Date.now()}`)
    const session = {
      id: 's-idb',
      title: 'Original',
      createdAt: 100,
      updatedAt: 200,
      rootMessageId: 'u1',
      messages: [
        {
          id: 'u1',
          role: 'user' as const,
          content: 'hi',
          files: [
            {
              id: 'blob-u1',
              serverId: null,
              name: 'doc.txt',
              size: 4,
              isImage: false,
              mimeType: 'text/plain',
            },
          ],
          createdAt: 100,
        },
      ],
    }

    await store.saveSession(session)
    assert.equal((await store.loadSummaries()).length, 1)
    await store.renameSession('s-idb', 'Renamed', true)
    const reloaded = await store.loadSession('s-idb')
    assert.equal(reloaded?.title, 'Renamed')
    assert.equal(reloaded?.titleLocked, true)

    const orphaned = await store.deleteSession('s-idb')
    assert.deepEqual(orphaned, ['blob-u1'])
    assert.deepEqual(await store.loadSummaries(), [])
    store.close?.()
  })
})

describe('conversations: getTurnSnapshot referential stability', () => {
  it('returns the same TurnSnapshot reference while unchanged and a new reference after updates', async () => {
    const slice = createTestSlice()
    await slice.commands.init()
    await slice.replaceSessions(async () => ({
      sessions: [
        {
          id: 's-snap',
          title: 'Thinking chat',
          createdAt: 1,
          updatedAt: 2,
          rootMessageId: 'u1',
          messages: [
            {
              id: 'u1',
              role: 'user',
              content: 'Think about this',
              files: [],
              createdAt: 1,
              selectedChildId: 'a1',
            },
            {
              id: 'a1',
              role: 'assistant',
              parentId: 'u1',
              createdAt: 2,
              model: null,
              prefix: false,
              status: 'done',
              thinking: true,
              blocks: [
                { type: 'thinking', thinking: 'Step 1', startedAt: 1000, endedAt: 3000 },
                { type: 'text', text: 'Answer' },
              ],
            },
          ],
        },
      ],
      blobs: [],
    }))
    await slice.commands.selectSession('s-snap')

    const first = slice.getTurnSnapshot('s-snap', 'a1')
    const second = slice.getTurnSnapshot('s-snap', 'a1')
    assert.ok(first)
    assert.equal(
      Object.is(first, second),
      true,
      'getTurnSnapshot must return a cached reference for useSyncExternalStore'
    )
    assert.equal(slice.getTurnSnapshot('s-snap', 'missing'), null)

    // Updating the turn produces a new snapshot that is itself stable on subsequent reads
    await slice.replaceSessions(async () => ({
      sessions: [
        {
          id: 's-snap',
          title: 'Thinking chat',
          createdAt: 1,
          updatedAt: 3,
          rootMessageId: 'u1',
          messages: [
            {
              id: 'u1',
              role: 'user',
              content: 'Think about this',
              files: [],
              createdAt: 1,
              selectedChildId: 'a1',
            },
            {
              id: 'a1',
              role: 'assistant',
              parentId: 'u1',
              createdAt: 2,
              model: null,
              prefix: false,
              status: 'done',
              thinking: true,
              blocks: [
                { type: 'thinking', thinking: 'Step 1\nStep 2', startedAt: 1000, endedAt: 4000 },
                { type: 'text', text: 'Updated answer' },
              ],
            },
          ],
        },
      ],
      blobs: [],
    }))
    await slice.commands.selectSession('s-snap')

    const third = slice.getTurnSnapshot('s-snap', 'a1')
    const fourth = slice.getTurnSnapshot('s-snap', 'a1')
    assert.ok(third)
    assert.notEqual(third, first)
    assert.equal(Object.is(third, fourth), true)
    assert.equal(
      third.blocks[0]?.type === 'thinking' ? third.blocks[0].thinking : '',
      'Step 1\nStep 2'
    )

    slice.dispose()
  })
})
