import 'fake-indexeddb/auto'
import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { classifyApiError, type ModelProvider } from '@deepseek-chat/lib-agent'
import { createToolRegistry, type ToolCapability } from '@deepseek-chat/lib-tools'
import { memoryStore } from '@deepseek-chat/test-support'
import {
  buildReplyView,
  createIndexedDbSessionStore,
  type AssistantMessage,
  type Session,
} from '@deepseek-chat/slice-conversations'
import { createTestSlice } from './harness.js'
import { memorySessionStore } from './memorySessionStore.js'

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

describe('conversations: kernel LRU cache pinning and historyEpoch replacement', () => {
  it('pins active, streaming, and unsaved sessions during LRU eviction and aborts in-flight turns on replaceSessions', async () => {
    const baseSessions = memorySessionStore()
    let releaseBlockedSave: (() => void) | null = null
    let blockNextSaveFor: string | null = null
    const wrappedSessions = {
      ...baseSessions,
      saveSession: async (session: Session) => {
        if (blockNextSaveFor === session.id) {
          blockNextSaveFor = null
          await new Promise<void>((resolve) => {
            releaseBlockedSave = resolve
          })
        }
        return baseSessions.saveSession(session)
      },
    }

    let streamAborted = false
    const testModel = {
      id: 'deepseek-chat',
      provider: 'test',
      label: 'Test Chat',
      contextWindow: 128_000,
      maxOutputTokens: 8_192,
      capabilities: {
        thinking: false,
        vision: false,
        documents: false,
        tools: false,
        promptCaching: false,
      },
    }
    const provider: ModelProvider = {
      id: 'test',
      label: 'Test',
      defaultModel: testModel.id,
      models: [testModel],
      isConfigured: () => true,
      modelSpec: () => testModel,
      classifyError: classifyApiError,
      streamMessage: async function* (_req, signal) {
        yield {
          type: 'message_start',
          message: {
            id: 'msg-pin',
            model: testModel.id,
            usage: {
              input_tokens: 10,
              cache_creation_input_tokens: 0,
              cache_read_input_tokens: 0,
              output_tokens: 0,
            },
          },
        }
        await new Promise<void>((resolve) => {
          if (signal.aborted) {
            streamAborted = true
            resolve()
            return
          }
          signal.addEventListener(
            'abort',
            () => {
              streamAborted = true
              resolve()
            },
            { once: true }
          )
        })
        throw signal.reason ?? new DOMException('Aborted', 'AbortError')
      },
    }

    const slice = createTestSlice({
      provider,
      sessions: wrappedSessions,
      autoTitle: false,
    })
    await slice.commands.init()

    const makeSession = (index: number): Session => ({
      id: `s${index}`,
      title: `Chat ${index}`,
      createdAt: index * 10,
      updatedAt: index * 10,
      rootMessageId: `u${index}`,
      messages: [
        {
          id: `u${index}`,
          role: 'user',
          content: `Hello ${index}`,
          files: [],
          createdAt: index * 10,
        },
      ],
    })
    await slice.replaceSessions(async () => ({
      sessions: [1, 2, 3, 4, 5, 6, 7].map(makeSession),
      blobs: [],
    }))

    const tick = () => new Promise((resolve) => setTimeout(resolve, 10))

    // Load s1 and start a long-running streaming reply (s1 is oldest accessed, but streaming-pinned).
    slice.commands.selectSession('s1')
    await tick()
    slice.commands.setDraft('s1', 'Keep streaming')
    assert.equal(slice.commands.send('s1'), true)
    await tick()
    assert.deepEqual(slice.getState().replying, ['s1'])

    // Load s2 and leave a save in flight so s2 is unsaved-pinned.
    slice.commands.selectSession('s2')
    await tick()
    blockNextSaveFor = 's2'
    slice.commands.renameSession('s2', 'Unsaved title')
    await tick()
    assert.ok(releaseBlockedSave, 's2 save is in flight')

    // Load s3..s7 in order, pushing cached count past the 5-session limit.
    for (const id of ['s3', 's4', 's5', 's6', 's7']) {
      slice.commands.selectSession(id)
      await tick()
    }

    assert.ok(slice.getChatMessages('s1').length > 0, 'streaming session s1 stays pinned in cache')
    assert.ok(slice.getChatMessages('s2').length > 0, 'unsaved session s2 stays pinned in cache')
    assert.ok(slice.getChatMessages('s7').length > 0, 'active session s7 stays pinned in cache')
    assert.equal(slice.getChatMessages('s3').length, 0, 'oldest idle session s3 was evicted')
    assert.equal(slice.getChatMessages('s4').length, 0, 'second oldest idle session s4 was evicted')
    assert.ok(slice.getChatMessages('s5').length > 0, 'recent idle session s5 stays cached')
    assert.ok(slice.getChatMessages('s6').length > 0, 'recent idle session s6 stays cached')

    // Replacing history aborts the in-flight reply and bumps historyEpoch cleanly.
    const replacedCount = await slice.replaceSessions(async () => ({
      sessions: [makeSession(99)],
      blobs: [],
    }))
    assert.equal(streamAborted, true, 'in-flight reply was aborted before replacement')
    assert.equal(replacedCount, 1)
    assert.deepEqual(slice.getState().replying, [])
    assert.deepEqual(
      slice.getState().sessions.map((s) => s.id),
      ['s99']
    )

    // Completing the stale pre-epoch save does not resurrect s2 or corrupt the new epoch.
    const release = releaseBlockedSave as (() => void) | null
    release?.()
    await tick()
    assert.deepEqual(
      slice.getState().sessions.map((s) => s.id),
      ['s99']
    )

    slice.dispose()
  })
})
