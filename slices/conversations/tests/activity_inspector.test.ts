import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import {
  createToolRegistry,
  type ToolCapability,
  type ToolStepPresenter,
} from '@deepseek-chat/lib-tools'
import type { PanelLayout, PanelSlot } from '@deepseek-chat/spine/ports'
import { EventLog } from '@deepseek-chat/spine/runtime'
import {
  buildActivityTimeline,
  extractTurnSources,
  type AssistantMessage,
  type Session,
  type TurnSnapshot,
} from '@deepseek-chat/slice-conversations'
import { createTestSlice } from './harness.js'

const fakePanel = (initialSessionId: string | null = 's1') => {
  const shown = new Map<string, 'activity' | 'other'>()
  let layout: PanelLayout = {
    activeSessionId: initialSessionId,
    animating: false,
    resizing: false,
    overlayLocked: false,
    width: 400,
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

const makeSession = (
  id: string,
  turns: readonly {
    readonly userId: string
    readonly prompt: string
    readonly assistantId: string
    readonly blocks: AssistantMessage['blocks']
  }[]
): Session => {
  const messages: Session['messages'] = []
  let prevId: string | null = null
  for (const turn of turns) {
    const userMsg = {
      id: turn.userId,
      parentId: prevId,
      selectedChildId: turn.assistantId,
      role: 'user' as const,
      content: turn.prompt,
      files: [],
      createdAt: 1000,
    }
    const prev = messages.at(-1)
    if (prev) {
      prev.selectedChildId = userMsg.id
    }
    messages.push(userMsg)
    messages.push({
      id: turn.assistantId,
      parentId: turn.userId,
      role: 'assistant',
      createdAt: 2000,
      model: null,
      status: 'done',
      blocks: turn.blocks,
    })
    prevId = turn.assistantId
  }
  return {
    id,
    title: `Chat ${id}`,
    createdAt: 1000,
    updatedAt: 2000,
    rootMessageId: messages[0]?.id ?? null,
    messages,
  }
}

const presenterCapability = (id: string, presenter: ToolStepPresenter): ToolCapability => ({
  id,
  declareTools: () => [],
  instructions: () => null,
  handles: () => false,
  effectOf: () => 'read',
  run: async () => ({ content: '', status: 'ok' }),
  presenter,
})

describe('conversations/cells/activity-inspector: panel lifecycle, PanelSlot ownership, & EventLog reactivity', () => {
  it('resolves active target in follow_reading and pinned modes, reads PanelSlot directly on displacement, and cleans up on session lifecycle', async () => {
    const log = new EventLog()
    const panel = fakePanel('s1')
    const slice = createTestSlice({ log, activityPanel: panel.slot })
    assert.ok(slice.activity)

    await slice.commands.init()
    await slice.replaceSessions(async () => ({
      sessions: [
        makeSession('s1', [
          {
            userId: 'u1',
            prompt: 'Latest prompt',
            assistantId: 'm-latest',
            blocks: [{ type: 'thinking', thinking: 'Plan', startedAt: 0, endedAt: 2000 }],
          },
        ]),
        makeSession('s2', [
          {
            userId: 'u2',
            prompt: 'Second chat prompt',
            assistantId: 'm2',
            blocks: [{ type: 'text', text: 'Answer' }],
          },
        ]),
      ],
      blobs: [],
    }))
    slice.commands.selectSession('s1')
    await new Promise((resolve) => setTimeout(resolve, 10))

    // First-class header toggle opens following the reader (latest turn when transcript has not reported).
    slice.activity.togglePanel('s1')
    assert.equal(panel.slot.isOpen('s1'), true)
    assert.deepEqual(slice.activity.getSelection(), {
      kind: 'follow_reading',
      sessionId: 's1',
      tab: 'activity',
    })
    assert.deepEqual(slice.activity.getTarget(), {
      sessionId: 's1',
      messageId: 'm-latest',
      tab: 'activity',
    })

    // Closing clears selection and active target.
    slice.activity.togglePanel('s1')
    assert.equal(panel.slot.isOpen('s1'), false)
    assert.equal(slice.activity.getSelection(), null)
    assert.equal(slice.activity.getTarget(), null)

    // Explicit inspection pins a specific turn and tab.
    slice.activity.inspectTurn('s1', 'm-latest', 'activity')
    assert.deepEqual(slice.activity.getTarget(), {
      sessionId: 's1',
      messageId: 'm-latest',
      tab: 'activity',
    })
    assert.equal(panel.slot.isOpen('s1'), true)

    // Displace with another right panel -> getTarget reads PanelSlot directly and reports null,
    // and toggling Activity back on resumes the session's pinned selection.
    panel.displace('s1')
    assert.equal(slice.activity.getTarget(), null)
    slice.activity.togglePanel('s1')
    assert.deepEqual(slice.activity.getTarget(), {
      sessionId: 's1',
      messageId: 'm-latest',
      tab: 'activity',
    })
    assert.equal(panel.slot.isOpen('s1'), true)

    // Same pinned untargeted request again toggles closed.
    slice.activity.inspectTurn('s1', 'm-latest', 'activity')
    assert.equal(slice.activity.getTarget(), null)
    assert.equal(panel.slot.isOpen('s1'), false)

    // Re-open, then deleting the session clears selection.
    slice.activity.inspectTurn('s1', 'm-latest', 'sources')
    await slice.commands.removeSession('s1')
    assert.equal(slice.activity.getTarget(), null)
    assert.equal(slice.activity.getSelection(), null)

    // Re-open on s2, switch active session to new chat -> clears s2 selection.
    panel.setActive('s2')
    slice.commands.selectSession('s2')
    await new Promise((resolve) => setTimeout(resolve, 10))
    slice.activity.inspectTurn('s2', 'm2', 'activity')
    assert.equal(slice.activity.getTarget()?.sessionId, 's2')
    slice.commands.newChat()
    assert.equal(slice.activity.getTarget(), null)

    // History replacement clears selection.
    slice.activity.inspectTurn('s2', 'm2', 'activity')
    await slice.replaceSessions(async () => ({ sessions: [], blobs: [] }))
    assert.equal(slice.activity.getSelection(), null)

    slice.dispose()
  })

  it('keeps panel open and bumps focusNonce on callId-targeted inspection, clearing focus on HeaderToggle resume', () => {
    const log = new EventLog()
    const panel = fakePanel('s1')
    const slice = createTestSlice({ log, activityPanel: panel.slot })
    assert.ok(slice.activity)

    slice.activity.inspectTurn('s1', 'm1', 'activity', 'c1')
    assert.equal(panel.slot.isOpen('s1'), true)
    assert.deepEqual(slice.activity.getSelection(), {
      kind: 'pinned',
      sessionId: 's1',
      messageId: 'm1',
      tab: 'activity',
      focusedCallId: 'c1',
      focusNonce: 1,
    })

    // Repeat click on the exact same callId stays open and bumps focusNonce.
    slice.activity.inspectTurn('s1', 'm1', 'activity', 'c1')
    assert.equal(panel.slot.isOpen('s1'), true)
    assert.deepEqual(slice.activity.getSelection(), {
      kind: 'pinned',
      sessionId: 's1',
      messageId: 'm1',
      tab: 'activity',
      focusedCallId: 'c1',
      focusNonce: 2,
    })

    // Clicking another row updates focusedCallId and keeps panel open.
    slice.activity.inspectTurn('s1', 'm1', 'activity', 'c2')
    assert.equal(panel.slot.isOpen('s1'), true)
    assert.deepEqual(slice.activity.getSelection(), {
      kind: 'pinned',
      sessionId: 's1',
      messageId: 'm1',
      tab: 'activity',
      focusedCallId: 'c2',
      focusNonce: 3,
    })

    // Displacing and resuming via HeaderToggle strips stale focusedCallId.
    panel.displace('s1')
    slice.activity.togglePanel('s1')
    assert.deepEqual(slice.activity.getSelection(), {
      kind: 'pinned',
      sessionId: 's1',
      messageId: 'm1',
      tab: 'activity',
    })

    // Untargeted request for the same pinned turn toggles closed.
    slice.activity.inspectTurn('s1', 'm1', 'activity')
    assert.equal(panel.slot.isOpen('s1'), false)
    assert.equal(slice.activity.getSelection(), null)

    slice.dispose()
  })
})

describe('conversations/cells/activity-inspector: timeline reduction, folded narration, round-linked thinking, and sources', () => {
  it('coalesces lanes, folds inter-tool narration onto the following visible step, links thinking rounds to steps, and separates cited vs other sources', () => {
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
        { type: 'thinking', thinking: 'Initial plan', startedAt: 0, endedAt: 1000 },
        { type: 'text', text: 'Let me check the first tool.' },
        { type: 'tool_use', id: 'c1', name: 'tool_a', input: { summary: 'Checking first tool' } },
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
        { type: 'thinking', thinking: 'Re-evaluating next action', startedAt: 1000, endedAt: 3500 },
        { type: 'text', text: 'That worked, moving to step two.' },
        { type: 'tool_use', id: 'c3', name: 'hidden_step', input: {} },
        {
          type: 'tool_result',
          tool_use_id: 'c3',
          capability: 'cap-a',
          content: 'ok',
          status: 'ok',
        },
        { type: 'tool_use', id: 'c2', name: 'tool_b', input: { summary: 'Running second tool' } },
        {
          type: 'tool_result',
          tool_use_id: 'c2',
          capability: 'cap-a',
          content: 'ok',
          status: 'ok',
        },
        { type: 'tool_use', id: 'c4', name: 'unmounted_tool', input: { x: 1 } },
        {
          type: 'tool_result',
          tool_use_id: 'c4',
          capability: 'cap-missing',
          content: 'boom error',
          status: 'error',
        },
        { type: 'thinking', thinking: 'Synthesizing final reply', startedAt: 4000, endedAt: 5000 },
        { type: 'text', text: 'Answer citing [ref:1].' },
      ],
    }

    const timeline = buildActivityTimeline(
      turn,
      (capId) => (capId === 'cap-a' ? customPresenter : null),
      5000
    )

    assert.equal(timeline.phases.length, 2)
    assert.equal(timeline.phases[0]?.type, 'lane')
    if (timeline.phases[0]?.type === 'lane') {
      assert.equal(timeline.phases[0].entries.length, 2)
      assert.equal(timeline.phases[0].items[0]?.precedingNote, 'Let me check the first tool.')
      assert.equal(timeline.phases[0].items[1]?.precedingNote, 'That worked, moving to step two.')
      assert.equal(timeline.phases[0].presenter, customPresenter)
    }
    assert.equal(timeline.phases[1]?.type, 'lane')
    if (timeline.phases[1]?.type === 'lane') {
      assert.equal(timeline.phases[1].presenter, null)
    }

    assert.equal(timeline.thinkingSeconds, 5)
    assert.equal(timeline.thinkingRounds.length, 3)
    assert.equal(timeline.thinkingRounds[0]?.nextStepCallId, 'c1')
    assert.equal(timeline.thinkingRounds[0]?.nextStepLabel, 'Checking first tool')
    assert.equal(timeline.thinkingRounds[1]?.nextStepCallId, 'c2')
    assert.equal(timeline.thinkingRounds[1]?.nextStepLabel, 'Running second tool')
    assert.equal(timeline.thinkingRounds[2]?.nextStepCallId, null)
    assert.equal(timeline.thinkingRounds[2]?.nextStepLabel, null)

    assert.equal(timeline.failedSteps.length, 1)
    assert.deepEqual(timeline.failedSteps[0], {
      callId: 'c4',
      label: 'unmounted_tool',
      preview: 'boom error',
    })

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

describe('conversations/cells/activity-inspector: ActivityPanel rendering & reading follow', () => {
  it('expands reasoning on thinking-only turns, collapses on tool turns, and groups multi-round reasoning inside', async () => {
    const log = new EventLog()
    const panel = fakePanel('s1')
    const slice = createTestSlice({ log, activityPanel: panel.slot })
    assert.ok(slice.activity)

    await slice.commands.init()
    await slice.replaceSessions(async () => ({
      sessions: [
        makeSession('s1', [
          {
            userId: 'u1',
            prompt: 'Think only',
            assistantId: 'm1',
            blocks: [
              {
                type: 'thinking',
                thinking: 'First **reasoning** step',
                startedAt: 1000,
                endedAt: 4000,
              },
              {
                type: 'thinking',
                thinking: 'Second **reasoning** round',
                startedAt: 4000,
                endedAt: 6000,
              },
              { type: 'text', text: 'Final answer' },
            ],
          },
          {
            userId: 'u2',
            prompt: 'Use a tool',
            assistantId: 'm2',
            blocks: [
              {
                type: 'thinking',
                thinking: 'Hidden **mixed** thought',
                startedAt: 1000,
                endedAt: 3000,
              },
              {
                type: 'tool_use',
                id: 'c1',
                name: 'custom_a',
                input: { summary: 'Inspecting page' },
              },
              { type: 'tool_result', tool_use_id: 'c1', content: 'OK', status: 'ok' },
              { type: 'text', text: 'Final answer' },
            ],
          },
        ]),
      ],
      blobs: [],
    }))
    slice.commands.selectSession('s1')
    await new Promise((resolve) => setTimeout(resolve, 10))

    slice.activity.inspectTurn('s1', 'm1', 'activity')
    const html = renderToStaticMarkup(createElement(slice.ActivityPanel))
    assert.match(
      html,
      /ds-activity-panel/,
      'scopes panel markdown overrides under ds-activity-panel'
    )
    assert.match(html, /<h2\b[^>]*>Activity<\/h2>/, 'exposes accessible panel heading')
    assert.match(html, /Thought for 5s/)
    assert.match(html, /aria-expanded="true"/)
    assert.match(html, /<strong><span>reasoning<\/span><\/strong>/)
    assert.match(html, /Before final reply/)
    const reasoningIdx = html.indexOf('Thought for 2s')
    const stepIdx = html.indexOf('Inspecting page')
    assert.ok(reasoningIdx >= 0 && stepIdx > reasoningIdx, 'reasoning stays pinned above steps')
    assert.doesNotMatch(
      html,
      /<strong><span>mixed<\/span><\/strong>/,
      'reasoning stays collapsed by default when tool steps exist'
    )
    slice.dispose()
  })

  it('promotes outputs & visuals, keeps failed steps quiet, folds narration into expanded step details, and keeps Sources mounted', async () => {
    const log = new EventLog()
    const panel = fakePanel('s1')
    const presenter: ToolStepPresenter = {
      summarize: (call, result) => ({
        lane: 'demo',
        liveVerb: 'Working',
        detail: `RAW_FALLBACK_${call.name}`,
        meta: '0.4s',
        visuals:
          call.id === 'c2'
            ? [
                {
                  src: 'data:image/png;base64,AA==',
                  alt: 'Screenshot of DuckDuckGo',
                  caption: 'Second human step',
                  href: 'https://duckduckgo.com/',
                },
              ]
            : undefined,
        failed: result?.status === 'error',
        hasDetail: true,
      }),
      renderStepDetail: ({ entry }) =>
        createElement('div', null, entry.result?.content ?? 'NO_RESULT'),
    }
    const slice = createTestSlice({
      log,
      activityPanel: panel.slot,
      tools: createToolRegistry([presenterCapability('demo', presenter)]),
      ui: {
        voice: null,
        openFile: () => undefined,
        openSettings: () => undefined,
        openInApp: null,
        saveFile: async () => undefined,
      },
    })
    assert.ok(slice.activity)

    await slice.commands.init()
    await slice.replaceSessions(async () => ({
      sessions: [
        makeSession('s1', [
          {
            userId: 'u1',
            prompt: 'Run tools',
            assistantId: 'm1',
            blocks: [
              { type: 'text', text: 'NARRATION_BEFORE_C1' },
              {
                type: 'tool_use',
                id: 'c1',
                name: 'custom_a',
                input: { summary: 'First human step' },
              },
              {
                type: 'tool_result',
                tool_use_id: 'c1',
                capability: 'demo',
                content: 'PRIVATE_IP_BLOCKED',
                status: 'error',
              },
              { type: 'text', text: 'NARRATION_BEFORE_C2' },
              {
                type: 'tool_use',
                id: 'c2',
                name: 'custom_b',
                input: { summary: 'Second human step' },
              },
              {
                type: 'tool_result',
                tool_use_id: 'c2',
                capability: 'demo',
                content: 'BETA_OUTPUT',
                status: 'ok',
                files: [
                  {
                    id: 'f1',
                    name: 'report.md',
                    path: 'docs/report.md',
                    title: 'Quarterly Report',
                    size: 2048,
                    mimeType: 'text/markdown',
                    version: 1,
                  },
                  {
                    id: 'f2',
                    name: 'report.md',
                    path: 'docs/report.md',
                    title: 'Quarterly Report',
                    size: 3072,
                    mimeType: 'text/markdown',
                    version: 2,
                  },
                ],
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
            ],
          },
        ]),
      ],
      blobs: [],
    }))
    slice.commands.selectSession('s1')
    await new Promise((resolve) => setTimeout(resolve, 10))

    slice.activity.inspectTurn('s1', 'm1', 'activity')
    const collapsedHtml = renderToStaticMarkup(createElement(slice.ActivityPanel))
    assert.match(collapsedHtml, /<h2\b[^>]*>Activity<\/h2>/)
    assert.match(collapsedHtml, /data-activity-call-id="c1"/)
    assert.match(collapsedHtml, /data-activity-call-id="c2"/)
    assert.match(collapsedHtml, /First human step/)
    assert.match(collapsedHtml, /Second human step/)
    assert.doesNotMatch(collapsedHtml, /RAW_FALLBACK_/)
    assert.match(collapsedHtml, /rowIconError/)
    assert.match(collapsedHtml, /\(Failed\)/)
    assert.doesNotMatch(collapsedHtml, /PRIVATE_IP_BLOCKED/)
    assert.doesNotMatch(collapsedHtml, /badgeDanger|Step failed/)
    assert.match(collapsedHtml, /Outputs \(2\)/)
    assert.match(collapsedHtml, /Open file: Quarterly Report/)
    assert.match(collapsedHtml, /report\.md/)
    assert.match(collapsedHtml, /MD/)
    assert.doesNotMatch(collapsedHtml, /·/)
    assert.match(collapsedHtml, /Inspect visual: Second human step/)
    assert.doesNotMatch(collapsedHtml, /NARRATION_BEFORE_C1|NARRATION_BEFORE_C2/)
    assert.doesNotMatch(collapsedHtml, /BETA_OUTPUT/)
    assert.match(collapsedHtml, /<button[^>]*aria-haspopup="menu"[^>]*>[\s\S]*?Activity/)
    assert.match(collapsedHtml, /hidden=""[^>]*>[\s\S]*Example/)

    slice.activity.inspectTurn('s1', 'm1', 'activity', 'c2')
    const focusedHtml = renderToStaticMarkup(createElement(slice.ActivityPanel))
    assert.match(focusedHtml, /BETA_OUTPUT/)
    assert.match(focusedHtml, /NARRATION_BEFORE_C2/)
    assert.doesNotMatch(focusedHtml, /NARRATION_BEFORE_C1/)
    assert.match(focusedHtml, /data-activity-call-id="c2" data-activity-selected="true"/)
    slice.dispose()
  })

  it('follows the reader, pins a turn until the reader moves on, shows every turn as a chapter, and renders EmptyState on empty chats', async () => {
    const log = new EventLog()
    const panel = fakePanel('s1')
    const slice = createTestSlice({ log, activityPanel: panel.slot })
    assert.ok(slice.activity)

    // Empty chat renders calm EmptyState
    slice.activity.togglePanel('s1')
    assert.equal(slice.activity.getTarget(), null)
    const emptyHtml = renderToStaticMarkup(createElement(slice.ActivityPanel))
    assert.match(emptyHtml, /No activity yet/)
    assert.match(emptyHtml, /inspect the steps and evidence here/)
    slice.activity.close()

    await slice.commands.init()
    await slice.replaceSessions(async () => ({
      sessions: [
        makeSession('s1', [
          {
            userId: 'u1',
            prompt: 'First question',
            assistantId: 'm1',
            blocks: [{ type: 'thinking', thinking: 'Alpha thought', startedAt: 0, endedAt: 2000 }],
          },
          {
            userId: 'u2',
            prompt: 'Second question',
            assistantId: 'm2',
            blocks: [{ type: 'thinking', thinking: 'Beta thought', startedAt: 0, endedAt: 5000 }],
          },
        ]),
      ],
      blobs: [],
    }))
    slice.commands.selectSession('s1')
    await new Promise((resolve) => setTimeout(resolve, 10))
    const render = () => renderToStaticMarkup(createElement(slice.ActivityPanel))

    slice.activity.togglePanel('s1')
    assert.deepEqual(slice.activity.getSelection(), {
      kind: 'follow_reading',
      sessionId: 's1',
      tab: 'activity',
    })
    assert.equal(slice.activity.getTarget()?.messageId, 'm2')
    const latestHtml = render()
    const first = latestHtml.indexOf('First question')
    const second = latestHtml.indexOf('Second question')
    assert.ok(first >= 0 && second > first, 'every turn is a chapter, in order')
    assert.match(latestHtml, /Thought for 2s[\s\S]*Thought for 5s/)
    assert.match(latestHtml, /aria-label="Turn 2: Second question" aria-current="true"/)
    assert.match(latestHtml, /aria-label="Previous turn"/)
    assert.doesNotMatch(latestHtml, /·/)

    // Reader scrolls transcript back to turn 1 -> panel follows.
    slice.activity.setReadingPosition('s1', 'm1', 'reader')
    assert.equal(slice.activity.getTarget()?.messageId, 'm1')
    assert.match(render(), /aria-label="Turn 1: First question" aria-current="true"/)

    // Picking turn 2 in panel pins it and asks transcript to reveal it.
    slice.activity.selectTurn('s1', 'm2')
    assert.equal(slice.activity.getRevealRequest()?.sessionId, 's1')
    assert.equal(slice.activity.getRevealRequest()?.messageId, 'm2')
    assert.equal(slice.activity.getSelection()?.kind, 'pinned')

    // Reveal-caused position changes never release the pin.
    slice.activity.setReadingPosition('s1', 'm2', 'reveal')
    assert.equal(slice.activity.getSelection()?.kind, 'pinned')
    slice.activity.setReadingPosition('s1', 'm1', 'reveal')
    assert.equal(slice.activity.getTarget()?.messageId, 'm2')

    // Reader scrolling to another turn releases the pin back to follow_reading.
    slice.activity.setReadingPosition('s1', 'm1', 'reader')
    assert.deepEqual(slice.activity.getSelection(), {
      kind: 'follow_reading',
      sessionId: 's1',
      tab: 'activity',
    })
    assert.equal(slice.activity.getTarget()?.messageId, 'm1')

    // Asking to inspect the turn already on show closes the panel even while following.
    slice.activity.inspectTurn('s1', 'm1', 'activity')
    assert.equal(panel.slot.isOpen('s1'), false)

    slice.dispose()
  })
})
