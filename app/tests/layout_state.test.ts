import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { memorySessionStore, type Session } from '@deepseek-chat/slice-conversations'
import { memoryStore } from '@deepseek-chat/spine/ports'
import { transitionSiderLayout } from '../layout.js'
import { createAppRuntime } from '../runtime.js'

Object.assign(globalThis, {
  document: { visibilityState: 'hidden' },
  requestAnimationFrame: (cb: () => void) => setTimeout(cb, 0),
  cancelAnimationFrame: (id: ReturnType<typeof setTimeout>) => clearTimeout(id),
})

const usage = {
  input_tokens: 1,
  cache_creation_input_tokens: 0,
  cache_read_input_tokens: 0,
  output_tokens: 1,
}

const makeInstantReplyFetch = () => async (url: string) => {
  if (!url.endsWith('/messages')) {
    throw new Error(`unexpected URL ${url}`)
  }
  const events = [
    { type: 'message_start', message: { id: 'm1', role: 'assistant', content: [], usage } },
    { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } },
    { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'Hello' } },
    { type: 'content_block_stop', index: 0 },
    { type: 'message_delta', delta: { stop_reason: 'end_turn' }, usage },
    { type: 'message_stop' },
  ]
  return new Response(
    events.map((e) => `event: ${e.type}\ndata: ${JSON.stringify(e)}\n\n`).join(''),
    { headers: { 'Content-Type': 'text/event-stream' } }
  )
}

const sampleSession = (id: string, title = 'Saved chat'): Session => ({
  id,
  title,
  createdAt: 1_000,
  updatedAt: 2_000,
  rootMessageId: 'u1',
  messages: [
    {
      id: 'u1',
      role: 'user',
      content: 'Hi',
      files: [],
      createdAt: 1_000,
    },
  ],
})

describe('transitionSiderLayout pure state machine', () => {
  it('enforces absent, collapsed and expanded invariants', () => {
    const absent = transitionSiderLayout({ mode: 'absent' }, { type: 'hydrated', sessionCount: 0 })
    assert.deepEqual(absent, { mode: 'absent' })

    // Cannot expand or collapse while zero sessions exist.
    assert.deepEqual(
      transitionSiderLayout(absent, { type: 'setCollapsed', collapsed: false }),
      absent
    )
    assert.deepEqual(
      transitionSiderLayout(absent, { type: 'setCollapsed', collapsed: true }),
      absent
    )

    // 0 -> 1 via normal send shows the toolbar with the sidebar collapsed (no layout jump).
    const firstReveal = transitionSiderLayout(absent, {
      type: 'sessionsChanged',
      sessionCount: 1,
      fromHistoryReplace: false,
    })
    assert.deepEqual(firstReveal, { mode: 'collapsed' })

    // User expands.
    const expanded = transitionSiderLayout(firstReveal, { type: 'setCollapsed', collapsed: false })
    assert.deepEqual(expanded, { mode: 'expanded' })

    // User collapses again.
    const collapsed = transitionSiderLayout(expanded, {
      type: 'setCollapsed',
      collapsed: true,
    })
    assert.deepEqual(collapsed, { mode: 'collapsed' })

    // 0 -> N via history import expands sidebar immediately.
    const imported = transitionSiderLayout(absent, {
      type: 'sessionsChanged',
      sessionCount: 3,
      fromHistoryReplace: true,
    })
    assert.deepEqual(imported, { mode: 'expanded' })

    // Deleting the last session from either collapsed or expanded returns to absent.
    assert.deepEqual(
      transitionSiderLayout(collapsed, {
        type: 'sessionsChanged',
        sessionCount: 0,
        fromHistoryReplace: false,
      }),
      { mode: 'absent' }
    )
    assert.deepEqual(
      transitionSiderLayout(expanded, {
        type: 'sessionsChanged',
        sessionCount: 0,
        fromHistoryReplace: false,
      }),
      { mode: 'absent' }
    )
  })
})

describe('AppRuntime sidebar lifecycle & startup hydration', () => {
  it('boots into absent sidebar with no forced API key dialog on fresh zero-session launch', async () => {
    const runtime = createAppRuntime({
      store: memoryStore(),
      fetch: makeInstantReplyFetch(),
      autoTitle: false,
    })

    await runtime.hydrate()

    assert.equal(runtime.slices.conversations.getState().ready, true)
    assert.equal(runtime.slices.conversations.getState().sessions.length, 0)
    assert.deepEqual(runtime.layout.getState(), { mode: 'absent' })
    assert.equal(
      runtime.settingsDialog.useStore.getState().open,
      false,
      'fresh launch must not slam open the Settings modal before the user sees the composer'
    )

    // Attempting to expand an empty sidebar is a no-op.
    runtime.layout.setSiderCollapsed(false)
    assert.deepEqual(runtime.layout.getState(), { mode: 'absent' })
    runtime.dispose()
  })

  it('hydrates existing sessions before first render so returning users start with sidebar expanded', async () => {
    const sessions = memorySessionStore()
    await sessions.saveSession(sampleSession('s-existing', 'Existing chat'))

    const runtime = createAppRuntime({
      store: memoryStore({ 'chat-demo:api-key': 'sk-returning' }),
      sessions,
      fetch: makeInstantReplyFetch(),
      autoTitle: false,
    })

    // Before hydration finishes, layout stays absent (never flashes an empty rail).
    assert.equal(runtime.layout.getState().mode, 'absent')

    await runtime.hydrate()

    assert.equal(runtime.slices.conversations.getState().ready, true)
    assert.equal(runtime.slices.conversations.getState().sessions.length, 1)
    assert.deepEqual(runtime.layout.getState(), { mode: 'expanded' })
    runtime.dispose()
  })

  it('shows the collapsed toolbar on first message, preserves manual toggles, and hides again when last chat is deleted', async () => {
    const runtime = createAppRuntime({
      store: memoryStore({ 'chat-demo:api-key': 'sk-first' }),
      fetch: makeInstantReplyFetch(),
      autoTitle: false,
    })

    await runtime.hydrate()
    assert.deepEqual(runtime.layout.getState(), { mode: 'absent' })

    // Send first message -> toolbar appears with the sidebar collapsed (no sidebar layout jump).
    runtime.slices.conversations.commands.setDraft(null, 'My very first question')
    assert.equal(runtime.slices.conversations.commands.send(null), true)
    assert.deepEqual(runtime.layout.getState(), { mode: 'collapsed' })
    await runtime.slices.conversations.commands.whenIdle()

    // Starting a second chat while collapsed keeps the user's collapsed preference.
    runtime.slices.conversations.commands.newChat()
    runtime.slices.conversations.commands.setDraft(null, 'Second chat')
    assert.equal(runtime.slices.conversations.commands.send(null), true)
    assert.deepEqual(runtime.layout.getState(), { mode: 'collapsed' })
    await runtime.slices.conversations.commands.whenIdle()

    // User opens the sidebar, then collapses it manually.
    runtime.layout.setSiderCollapsed(false)
    assert.deepEqual(runtime.layout.getState(), { mode: 'expanded' })
    runtime.layout.setSiderCollapsed(true)
    assert.deepEqual(runtime.layout.getState(), { mode: 'collapsed' })

    // Delete first of two sessions -> still 1 session left, remains collapsed.
    const [firstId, secondId] = runtime.slices.conversations.getState().sessions.map((s) => s.id)
    assert.ok(firstId && secondId)
    assert.equal(await runtime.slices.conversations.commands.removeSession(firstId), true)
    assert.deepEqual(runtime.layout.getState(), { mode: 'collapsed' })

    // Delete last remaining session -> returns cleanly to absent.
    assert.equal(await runtime.slices.conversations.commands.removeSession(secondId), true)
    assert.deepEqual(runtime.layout.getState(), { mode: 'absent' })

    runtime.dispose()
  })

  it('expands the full sidebar immediately when importing history into a zero-session runtime, without leaking on empty imports', async () => {
    const runtime = createAppRuntime({
      store: memoryStore({ 'chat-demo:api-key': 'sk-import' }),
      fetch: makeInstantReplyFetch(),
      autoTitle: false,
    })

    await runtime.hydrate()
    assert.equal(runtime.layout.getState().mode, 'absent')

    // Importing an empty archive keeps mode absent and must NOT leak onto a later first message.
    await runtime.slices.conversations.replaceSessions(async () => ({ sessions: [], blobs: [] }))
    assert.deepEqual(runtime.layout.getState(), { mode: 'absent' })

    runtime.slices.conversations.commands.setDraft(null, 'First real message')
    assert.equal(runtime.slices.conversations.commands.send(null), true)
    assert.deepEqual(runtime.layout.getState(), { mode: 'collapsed' })
    await runtime.slices.conversations.commands.whenIdle()

    // Clear all chats -> returns to absent.
    await runtime.slices.conversations.replaceSessions(async () => ({ sessions: [], blobs: [] }))
    assert.deepEqual(runtime.layout.getState(), { mode: 'absent' })

    // Import non-empty backup from absent -> expands full sidebar immediately for clear feedback.
    await runtime.slices.conversations.replaceSessions(async () => ({
      sessions: [sampleSession('imp-1', 'Imported 1'), sampleSession('imp-2', 'Imported 2')],
      blobs: [],
    }))
    assert.deepEqual(runtime.layout.getState(), { mode: 'expanded' })

    runtime.dispose()
  })

  it('isolates sidebar layout state across side-by-side runtime instances', async () => {
    const runtimeA = createAppRuntime({
      store: memoryStore({ 'chat-demo:api-key': 'sk-a' }),
      fetch: makeInstantReplyFetch(),
      autoTitle: false,
    })
    const runtimeB = createAppRuntime({
      store: memoryStore({ 'chat-demo:api-key': 'sk-b' }),
      fetch: makeInstantReplyFetch(),
      autoTitle: false,
    })

    await Promise.all([runtimeA.hydrate(), runtimeB.hydrate()])
    assert.equal(runtimeA.layout.getState().mode, 'absent')
    assert.equal(runtimeB.layout.getState().mode, 'absent')

    runtimeA.slices.conversations.commands.setDraft(null, 'Only in A')
    assert.equal(runtimeA.slices.conversations.commands.send(null), true)
    assert.deepEqual(runtimeA.layout.getState(), { mode: 'collapsed' })
    assert.deepEqual(runtimeB.layout.getState(), { mode: 'absent' })

    await runtimeA.slices.conversations.commands.whenIdle()
    runtimeA.dispose()
    runtimeB.dispose()
  })
})
