import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import type { ToolStepPresenter } from '@deepseek-chat/lib-tools'
import type {
  ActiveSessionChanged,
  SessionDeleted,
  SessionHistoryReplaced,
  TurnInspectionRequested,
} from '@deepseek-chat/spine/facts/session'
import type { PanelLayout, PanelSlot } from '@deepseek-chat/spine/ports'
import { EventLog } from '@deepseek-chat/spine/runtime'
import {
  buildActivityTimeline,
  createActivityInspectorSlice,
  extractTurnSources,
  type TurnSnapshot,
} from '@deepseek-chat/slice-activity-inspector'

const fakePanel = () => {
  const shown = new Map<string, 'activity' | 'other'>()
  let layout: PanelLayout = {
    activeSessionId: 's1',
    animating: false,
    resizing: false,
    overlayLocked: false,
    width: 540,
  }
  const listeners = new Set<() => void>()
  const emit = () => {
    for (const listener of [...listeners]) {
      listener()
    }
  }
  const slot: PanelSlot = {
    useStageSize: () => null,
    setStageSize: () => undefined,
    setResizing: () => undefined,
    isResizing: () => false,
    isOpen: (sid) => sid !== null && shown.get(sid) === 'activity',
    open: (sid) => {
      shown.set(sid, 'activity')
      emit()
    },
    close: (sid) => {
      if (shown.get(sid) === 'activity') {
        shown.delete(sid)
        emit()
      }
    },
    setAnimating: () => undefined,
    getLayout: () => layout,
    subscribe: (listener) => {
      listeners.add(listener)
      return () => {
        listeners.delete(listener)
      }
    },
    useLayout: (select) => select(layout),
  }
  return {
    slot,
    displace: (sid: string) => {
      shown.set(sid, 'other')
      emit()
    },
    setActive: (sid: string | null) => {
      layout = { ...layout, activeSessionId: sid }
      emit()
    },
  }
}

describe('slice-activity-inspector: panel lifecycle & EventLog reactivity', () => {
  it('supports header toggle (follow_latest), pinned TurnInspectionRequested, displacement isolation, and cleanup on facts', () => {
    const log = new EventLog()
    const panel = fakePanel()
    const slice = createActivityInspectorSlice({
      log,
      panel: panel.slot,
      turnSource: { getTurn: () => null, subscribe: () => () => undefined },
      getPresenter: () => null,
      openInApp: null,
    })

    // First-class header toggle opens in follow_latest mode and closes on second click.
    slice.togglePanel('s1')
    assert.equal(panel.slot.isOpen('s1'), true)
    assert.deepEqual(slice.getSelection(), {
      kind: 'follow_latest',
      sessionId: 's1',
      tab: 'activity',
    })
    assert.equal(slice.getTarget(), null, 'follow_latest has no pinned target')

    slice.togglePanel('s1')
    assert.equal(panel.slot.isOpen('s1'), false)
    assert.equal(slice.getSelection(), null)

    // Explicit TurnInspectionRequested pins a specific turn and tab.
    log.publish<TurnInspectionRequested>({
      type: 'TurnInspectionRequested',
      sessionId: 's1',
      messageId: 'm1',
      tab: 'activity',
    })
    assert.deepEqual(slice.getTarget(), { sessionId: 's1', messageId: 'm1', tab: 'activity' })
    assert.equal(panel.slot.isOpen('s1'), true)

    // Displace with another right panel -> getTarget reports null while hidden,
    // and toggling Activity back on resumes the session's pinned selection.
    panel.displace('s1')
    assert.equal(slice.getTarget(), null)
    slice.togglePanel('s1')
    assert.deepEqual(slice.getTarget(), { sessionId: 's1', messageId: 'm1', tab: 'activity' })
    assert.equal(panel.slot.isOpen('s1'), true)

    // Same pinned request again toggles closed.
    log.publish<TurnInspectionRequested>({
      type: 'TurnInspectionRequested',
      sessionId: 's1',
      messageId: 'm1',
      tab: 'activity',
    })
    assert.equal(slice.getTarget(), null)
    assert.equal(panel.slot.isOpen('s1'), false)

    // Re-open, then SessionDeleted clears it.
    log.publish<TurnInspectionRequested>({
      type: 'TurnInspectionRequested',
      sessionId: 's1',
      messageId: 'm1',
      tab: 'sources',
    })
    log.publish<SessionDeleted>({ type: 'SessionDeleted', sessionId: 's1' })
    assert.equal(slice.getTarget(), null)
    assert.equal(slice.getSelection(), null)

    // Re-open on s2, switch active session -> clears s2 selection.
    panel.setActive('s2')
    log.publish<TurnInspectionRequested>({
      type: 'TurnInspectionRequested',
      sessionId: 's2',
      messageId: 'm2',
      tab: 'activity',
    })
    log.publishSticky<ActiveSessionChanged>('unit', {
      type: 'ActiveSessionChanged',
      sessionId: 's3',
    })
    assert.equal(slice.getTarget(), null)

    // History replacement clears everything.
    log.publish<SessionHistoryReplaced>({ type: 'SessionHistoryReplaced' })
    assert.equal(slice.getSelection(), null)

    slice.dispose()
  })

  it('keeps panel open and bumps focusNonce on callId-targeted TurnInspectionRequested, clearing focus on HeaderToggle resume', () => {
    const log = new EventLog()
    const panel = fakePanel()
    const slice = createActivityInspectorSlice({
      log,
      panel: panel.slot,
      turnSource: { getTurn: () => null, subscribe: () => () => undefined },
      getPresenter: () => null,
      openInApp: null,
    })

    log.publish<TurnInspectionRequested>({
      type: 'TurnInspectionRequested',
      sessionId: 's1',
      messageId: 'm1',
      tab: 'activity',
      callId: 'c1',
    })
    assert.equal(panel.slot.isOpen('s1'), true)
    assert.deepEqual(slice.getSelection(), {
      kind: 'pinned',
      sessionId: 's1',
      messageId: 'm1',
      tab: 'activity',
      focusedCallId: 'c1',
      focusNonce: 1,
    })

    // Repeat click on the exact same callId stays open and bumps focusNonce.
    log.publish<TurnInspectionRequested>({
      type: 'TurnInspectionRequested',
      sessionId: 's1',
      messageId: 'm1',
      tab: 'activity',
      callId: 'c1',
    })
    assert.equal(panel.slot.isOpen('s1'), true)
    assert.deepEqual(slice.getSelection(), {
      kind: 'pinned',
      sessionId: 's1',
      messageId: 'm1',
      tab: 'activity',
      focusedCallId: 'c1',
      focusNonce: 2,
    })

    // Clicking another row updates focusedCallId and keeps panel open.
    log.publish<TurnInspectionRequested>({
      type: 'TurnInspectionRequested',
      sessionId: 's1',
      messageId: 'm1',
      tab: 'activity',
      callId: 'c2',
    })
    assert.equal(panel.slot.isOpen('s1'), true)
    assert.deepEqual(slice.getSelection(), {
      kind: 'pinned',
      sessionId: 's1',
      messageId: 'm1',
      tab: 'activity',
      focusedCallId: 'c2',
      focusNonce: 3,
    })

    // Displacing and resuming via HeaderToggle strips stale focusedCallId.
    panel.displace('s1')
    slice.togglePanel('s1')
    assert.deepEqual(slice.getSelection(), {
      kind: 'pinned',
      sessionId: 's1',
      messageId: 'm1',
      tab: 'activity',
    })

    // Untargeted request for the same pinned turn toggles closed.
    log.publish<TurnInspectionRequested>({
      type: 'TurnInspectionRequested',
      sessionId: 's1',
      messageId: 'm1',
      tab: 'activity',
    })
    assert.equal(panel.slot.isOpen('s1'), false)
    assert.equal(slice.getSelection(), null)

    slice.dispose()
  })
})

describe('slice-activity-inspector: lane coalescing, presenters, fallback, and sources', () => {
  it('coalesces consecutive steps in the same lane across thinking, folds hidden steps, falls back cleanly, and separates cited vs other sources', () => {
    const customPresenter: ToolStepPresenter = {
      summarize: (call) => ({
        lane: 'custom-lane',
        liveVerb: 'Working',
        hiddenInTimeline: call.name === 'hidden_step',
      }),
      renderActivity: () => null,
    }

    const turn: TurnSnapshot = {
      sessionId: 's1',
      messageId: 'm1',
      status: 'done',
      streaming: false,
      blocks: [
        { type: 'tool_use', id: 'c1', name: 'tool_a', input: { q: 'one' } },
        {
          type: 'tool_result',
          tool_use_id: 'c1',
          capability: 'cap-a',
          content: 'ok',
          status: 'ok',
          sources: [
            {
              url: 'https://cited.test',
              title: 'Cited',
              snippet: '',
              siteName: 'cited.test',
              publishedAt: null,
            },
            {
              url: 'https://other.test',
              title: 'Other',
              snippet: '',
              siteName: 'other.test',
              publishedAt: null,
            },
          ],
        },
        { type: 'thinking', thinking: 'Reasoning...', startedAt: 1000, endedAt: 3500 },
        { type: 'tool_use', id: 'c2', name: 'tool_b', input: { q: 'two' } },
        {
          type: 'tool_result',
          tool_use_id: 'c2',
          capability: 'cap-a',
          content: 'ok',
          status: 'ok',
        },
        { type: 'tool_use', id: 'c3', name: 'hidden_step', input: {} },
        {
          type: 'tool_result',
          tool_use_id: 'c3',
          capability: 'cap-a',
          content: 'ok',
          status: 'ok',
        },
        { type: 'tool_use', id: 'c4', name: 'unmounted_tool', input: { x: 1 } },
        {
          type: 'tool_result',
          tool_use_id: 'c4',
          capability: 'cap-missing',
          content: '42',
          status: 'ok',
        },
        { type: 'text', text: 'Answer citing [ref:1].' },
      ],
    }

    const timeline = buildActivityTimeline(
      turn,
      (capId) => (capId === 'cap-a' ? customPresenter : null),
      5000
    )

    assert.equal(
      timeline.phases.length,
      2,
      'c1+c2 coalesced across thinking, c3 folded out, c4 separate'
    )
    assert.equal(timeline.phases[0]?.type, 'lane')
    if (timeline.phases[0]?.type === 'lane') {
      assert.equal(timeline.phases[0].entries.length, 2)
      assert.equal(timeline.phases[0].presenter, customPresenter)
    }
    assert.equal(timeline.phases[1]?.type, 'lane')
    if (timeline.phases[1]?.type === 'lane') {
      assert.equal(
        timeline.phases[1].presenter,
        null,
        'falls back to generic renderer when slice unmounted'
      )
    }
    assert.equal(timeline.thinkingSeconds, 3)

    const sources = extractTurnSources(turn.blocks)
    assert.deepEqual(
      sources.cited.map((s) => s.url),
      ['https://cited.test']
    )
    assert.deepEqual(
      sources.other.map((s) => s.url),
      ['https://other.test']
    )
  })
})

describe('slice-activity-inspector: ActivityPanel rendering', () => {
  it('renders thinking-only turns expanded by default and pins reasoning above tool steps (collapsed) on tool turns', () => {
    const log = new EventLog()
    const panel = fakePanel()
    const thinkingOnlyBlocks: TurnSnapshot['blocks'] = [
      { type: 'thinking', thinking: 'First **reasoning** step', startedAt: 1000, endedAt: 4000 },
      { type: 'text', text: 'Final answer' },
    ]
    const mixedBlocks: TurnSnapshot['blocks'] = [
      { type: 'tool_use', id: 'c1', name: 'custom_a', input: { summary: 'Inspecting page' } },
      { type: 'tool_result', tool_use_id: 'c1', content: 'OK', status: 'ok' },
      { type: 'thinking', thinking: 'Hidden **mixed** thought', startedAt: 1000, endedAt: 3000 },
      { type: 'text', text: 'Final answer' },
    ]
    const turnMap: Record<string, TurnSnapshot> = {
      m1: {
        sessionId: 's1',
        messageId: 'm1',
        status: 'done',
        streaming: false,
        blocks: thinkingOnlyBlocks,
      },
      m2: {
        sessionId: 's1',
        messageId: 'm2',
        status: 'done',
        streaming: false,
        blocks: mixedBlocks,
      },
    }
    const slice = createActivityInspectorSlice({
      log,
      panel: panel.slot,
      turnSource: {
        // Deliberately returns a fresh wrapper each call to verify defensive snapshot handling.
        getTurn: (_sid, messageId) => {
          const snap = turnMap[messageId]
          return snap ? { ...snap } : null
        },
        subscribe: () => () => undefined,
      },
      getPresenter: () => null,
      openInApp: null,
    })

    log.publish<TurnInspectionRequested>({
      type: 'TurnInspectionRequested',
      sessionId: 's1',
      messageId: 'm1',
      tab: 'activity',
    })
    const thinkingOnlyHtml = renderToStaticMarkup(createElement(slice.ActivityPanel))
    assert.match(thinkingOnlyHtml, /Thought for 3s/)
    assert.match(thinkingOnlyHtml, /aria-expanded="true"/)
    assert.match(
      thinkingOnlyHtml,
      /<strong><span>reasoning<\/span><\/strong>/,
      'thinking-only turns expand reasoning immediately'
    )

    log.publish<TurnInspectionRequested>({
      type: 'TurnInspectionRequested',
      sessionId: 's1',
      messageId: 'm2',
      tab: 'activity',
    })
    const mixedHtml = renderToStaticMarkup(createElement(slice.ActivityPanel))
    const reasoningIdx = mixedHtml.indexOf('Thought for 2s')
    const stepIdx = mixedHtml.indexOf('Inspecting page')
    assert.ok(reasoningIdx >= 0 && stepIdx > reasoningIdx, 'reasoning is pinned above tool steps')
    assert.doesNotMatch(
      mixedHtml,
      /<strong><span>mixed<\/span><\/strong>/,
      'reasoning stays collapsed by default when tool steps exist'
    )
    slice.dispose()
  })

  it('renders tool steps collapsed by default, prefers human call.input.summary, and expands/selects only the focused callId', () => {
    const log = new EventLog()
    const panel = fakePanel()
    const presenter: ToolStepPresenter = {
      summarize: (call, result) => ({
        lane: 'demo',
        liveVerb: 'Working',
        detail: `RAW_FALLBACK_${call.name}`,
        meta: '0.4s',
        visuals:
          call.id === 'c2'
            ? [{ src: 'data:image/png;base64,AA==', alt: 'Screenshot of DuckDuckGo' }]
            : undefined,
        failed: result?.status === 'error',
        hasDetail: true,
      }),
      renderStepDetail: ({ entry }) =>
        createElement('div', null, entry.result?.content ?? 'NO_RESULT'),
    }
    const blocks: TurnSnapshot['blocks'] = [
      { type: 'tool_use', id: 'c1', name: 'custom_a', input: { summary: 'First human step' } },
      {
        type: 'tool_result',
        tool_use_id: 'c1',
        capability: 'demo',
        content: 'ALPHA_OUTPUT',
        status: 'error',
      },
      { type: 'tool_use', id: 'c2', name: 'custom_b', input: { summary: 'Second human step' } },
      {
        type: 'tool_result',
        tool_use_id: 'c2',
        capability: 'demo',
        content: 'BETA_OUTPUT',
        status: 'ok',
        sources: [
          {
            url: 'https://example.test',
            title: 'Example',
            snippet: 'Snippet',
            siteName: 'example.test',
            publishedAt: null,
          },
        ],
      },
    ]
    const slice = createActivityInspectorSlice({
      log,
      panel: panel.slot,
      turnSource: {
        getTurn: (sessionId, messageId) => ({
          sessionId,
          messageId,
          status: 'done',
          streaming: false,
          blocks,
        }),
        subscribe: () => () => undefined,
      },
      getPresenter: (capId) => (capId === 'demo' ? presenter : null),
      openInApp: null,
    })

    log.publish<TurnInspectionRequested>({
      type: 'TurnInspectionRequested',
      sessionId: 's1',
      messageId: 'm1',
      tab: 'activity',
    })
    const collapsedHtml = renderToStaticMarkup(createElement(slice.ActivityPanel))
    assert.match(collapsedHtml, /data-activity-call-id="c1"/)
    assert.match(collapsedHtml, /data-activity-call-id="c2"/)
    assert.match(collapsedHtml, /First human step/)
    assert.match(collapsedHtml, /Second human step/)
    assert.doesNotMatch(collapsedHtml, /RAW_FALLBACK_/, 'human input.summary beats fallback detail')
    assert.match(collapsedHtml, /Failed/, 'failed steps expose a non-color-only Failed label')
    assert.match(collapsedHtml, /Visuals/, 'visual artifacts surface the Visuals filter chip')
    assert.match(collapsedHtml, /Errors/, 'failed steps surface the Errors filter chip')
    assert.match(collapsedHtml, /role="tablist"/, 'uses accessible Tabs when sources exist')
    assert.match(collapsedHtml, /role="tabpanel"/, 'links tablist to accessible tabpanel')
    assert.match(collapsedHtml, /aria-controls="/, 'tabs wire aria-controls to tabpanels')
    assert.doesNotMatch(collapsedHtml, /ALPHA_OUTPUT/, 'untargeted steps start collapsed')
    assert.doesNotMatch(collapsedHtml, /BETA_OUTPUT/, 'untargeted steps start collapsed')

    log.publish<TurnInspectionRequested>({
      type: 'TurnInspectionRequested',
      sessionId: 's1',
      messageId: 'm1',
      tab: 'activity',
      callId: 'c2',
    })
    const focusedHtml = renderToStaticMarkup(createElement(slice.ActivityPanel))
    assert.doesNotMatch(focusedHtml, /ALPHA_OUTPUT/, 'non-targeted step remains collapsed')
    assert.match(focusedHtml, /BETA_OUTPUT/, 'focused callId expands immediately')
    assert.match(
      focusedHtml,
      /data-activity-call-id="c2" data-activity-selected="true"/,
      'focused callId carries persistent selected indicator'
    )
    slice.dispose()
  })

  it('follows the latest turn via HeaderToggle, exposes Follow latest when pinned behind, and formats turn switcher without middots', () => {
    const log = new EventLog()
    const panel = fakePanel()
    const turns = [
      {
        messageId: 'm1',
        turnNumber: 1,
        promptExcerpt: 'First question',
        streaming: false,
        hasActivity: true,
      },
      {
        messageId: 'm2',
        turnNumber: 2,
        promptExcerpt: 'Second question',
        streaming: false,
        hasActivity: true,
      },
    ] as const
    const turnMap: Record<string, TurnSnapshot> = {
      m1: {
        sessionId: 's1',
        messageId: 'm1',
        status: 'done',
        streaming: false,
        blocks: [{ type: 'thinking', thinking: 'Alpha thought', startedAt: 0, endedAt: 2000 }],
      },
      m2: {
        sessionId: 's1',
        messageId: 'm2',
        status: 'done',
        streaming: false,
        blocks: [{ type: 'thinking', thinking: 'Beta thought', startedAt: 0, endedAt: 5000 }],
      },
    }
    const slice = createActivityInspectorSlice({
      log,
      panel: panel.slot,
      turnSource: {
        getTurn: (_sid, mid) => turnMap[mid] ?? null,
        listTurns: () => turns,
        subscribe: () => () => undefined,
      },
      getPresenter: () => null,
      openInApp: null,
    })

    slice.togglePanel('s1')
    const latestHtml = renderToStaticMarkup(createElement(slice.ActivityPanel))
    assert.match(latestHtml, /Thought for 5s/, 'follow_latest displays the newest active turn')
    assert.match(latestHtml, /Turn 2: Second question/, 'shows turn switcher without middot')
    assert.doesNotMatch(latestHtml, /Follow latest/, 'follow_latest hides Follow latest button')

    slice.selectTurn('s1', 'm1')
    const pinnedHtml = renderToStaticMarkup(createElement(slice.ActivityPanel))
    assert.match(pinnedHtml, /Thought for 2s/, 'selectTurn switches to the chosen earlier turn')
    assert.match(pinnedHtml, /Follow latest/, 'pinned older turn surfaces Follow latest action')

    slice.followLatest('s1')
    assert.deepEqual(slice.getSelection(), {
      kind: 'follow_latest',
      sessionId: 's1',
      tab: 'activity',
    })
    const resumedHtml = renderToStaticMarkup(createElement(slice.ActivityPanel))
    assert.match(resumedHtml, /Thought for 5s/, 'followLatest resumes tracking newest turn')
    slice.dispose()
  })

  it('renders a structured EmptyState when opened on a brand-new chat with no activity', () => {
    const log = new EventLog()
    const panel = fakePanel()
    const slice = createActivityInspectorSlice({
      log,
      panel: panel.slot,
      turnSource: {
        getTurn: () => null,
        listTurns: () => [],
        subscribe: () => () => undefined,
      },
      getPresenter: () => null,
      openInApp: null,
    })

    slice.togglePanel('s1')
    const html = renderToStaticMarkup(createElement(slice.ActivityPanel))
    assert.match(html, /No activity yet/)
    assert.match(html, /Tool steps, code runs, screenshots, reasoning, and sources/)
    slice.dispose()
  })
})
