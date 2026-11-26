import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import {
  createToolRegistry,
  type DeliveredFileRef,
  type ToolCapability,
} from '@deepseek-chat/lib-tools'
import {
  buildInlineTrace,
  buildReplyView,
  buildTurnWorkStrip,
  getAreaTitle,
  getFrontStageNotes,
  needsWorkingIndicator,
  selectInlineTracePreview,
  type AssistantMessage,
  type InlineTraceItem,
} from '@deepseek-chat/slice-conversations'

const replyWith = (blocks: AssistantMessage['blocks'], thinking = false): AssistantMessage => ({
  id: 'a1',
  role: 'assistant',
  createdAt: 1_000,
  model: 'deepseek-flash',
  thinking,
  prefix: false,
  status: 'done',
  blocks,
})

const testRegistry = createToolRegistry([
  {
    id: 'search-cap',
    declareTools: () => [],
    instructions: () => null,
    handles: (name) => name === 'lookup' || name === 'fetch_page',
    effectOf: () => 'read',
    run: async () => ({ content: 'ok', status: 'ok' }),
    presenter: {
      summarize: (call, result) => ({
        lane: 'research',
        icon: call.name === 'lookup' ? 'icon-lookup' : 'icon-fetch',
        liveVerb: call.name === 'lookup' ? 'Searching' : 'Reading',
        tally: {
          key: call.name === 'lookup' ? 'searches' : 'pages',
          count: 1,
          label: (n) => (call.name === 'lookup' ? `${n} searches` : `${n} pages`),
        },
        stillRunning: !result || result.status === 'running',
        failed: result?.status === 'error',
      }),
      renderActivity: () => null,
    },
  } satisfies ToolCapability,
  {
    id: 'parallel-cap',
    declareTools: () => [],
    instructions: () => null,
    handles: (name) => name === 'spawn_worker' || name === 'wait_workers',
    effectOf: (name) => (name === 'spawn_worker' ? 'spawn' : 'session'),
    run: async () => ({ content: 'ok', status: 'ok' }),
    presenter: {
      summarize: (call, result, { capabilityState }) => {
        const tracks =
          (
            capabilityState as
              | {
                  tracks?: { id: string; label: string; detail: string | null; status: 'running' }[]
                }
              | undefined
          )?.tracks ?? []
        return {
          lane: 'workers',
          liveVerb: 'Running workers',
          liveTracks: tracks,
          hiddenInTimeline: call.name === 'wait_workers',
          stillRunning: !result || result.status === 'running',
        }
      },
      renderActivity: () => null,
    },
  } satisfies ToolCapability,
  {
    id: 'ask-cap',
    declareTools: () => [],
    instructions: () => null,
    handles: (name) => name === 'clarify',
    effectOf: () => 'interactive',
    run: async () => ({ content: 'ok', status: 'ok' }),
    presenter: {
      summarize: (_call, result) => ({
        lane: 'clarify',
        liveVerb: 'Waiting for answer',
        waitingForUser: !result || result.status === 'running',
        stillRunning: !result || result.status === 'running',
      }),
      renderActivity: () => null,
    },
  } satisfies ToolCapability,
])

describe('buildReplyView (domain-blind projection)', () => {
  it('deduplicates sources across tool results in call order and tracks cited indexes', () => {
    const view = buildReplyView(
      replyWith([
        { type: 'tool_use', id: 's1', name: 'lookup', input: { summary: 'Checking docs' } },
        {
          type: 'tool_result',
          tool_use_id: 's1',
          capability: 'search-cap',
          content: '[1] Alpha\n[2] Beta',
          status: 'ok',
          sources: [
            {
              url: 'https://alpha.example',
              title: 'Alpha',
              snippet: 'A snippet',
              siteName: 'alpha.example',
              publishedAt: null,
            },
            {
              url: 'https://beta.example',
              title: 'Beta',
              snippet: 'B snippet',
              siteName: 'beta.example',
              publishedAt: null,
            },
          ],
        },
        { type: 'tool_use', id: 's2', name: 'fetch_page', input: { url: 'https://gamma.example' } },
        {
          type: 'tool_result',
          tool_use_id: 's2',
          capability: 'search-cap',
          content: 'Gamma page',
          status: 'ok',
          sources: [
            {
              url: 'https://beta.example',
              title: 'Beta Duplicate',
              snippet: '',
              siteName: 'beta.example',
              publishedAt: null,
            },
            {
              url: 'https://gamma.example',
              title: 'Gamma',
              snippet: '',
              siteName: 'gamma.example',
              publishedAt: null,
            },
          ],
        },
        { type: 'text', text: 'Confirmed by Gamma[ref:3] and Alpha[citation:1].' },
      ]),
      false,
      testRegistry
    )

    assert.deepEqual(
      view.sources.map((s) => [s.index, s.url]),
      [
        [1, 'https://alpha.example'],
        [2, 'https://beta.example'],
        [3, 'https://gamma.example'],
      ]
    )
    assert.deepEqual(view.citedSourceIndexes, [3, 1])
    assert.equal(view.answer?.text, 'Confirmed by Gamma and Alpha.')
  })

  it('extracts streaming partial summary JSON for live getAreaTitle', () => {
    const view = buildReplyView(
      replyWith(
        [
          {
            type: 'tool_use',
            id: 'f1',
            name: 'lookup',
            input: {},
            inputJson: '{"summary":"Drafting the quarterly summary","body":"<!doctype html>',
          },
        ],
        true
      ),
      true,
      testRegistry
    )

    assert.equal(view.steps[0]?.type, 'tool')
    assert.equal(getAreaTitle(view, true, 2_000, false), 'Drafting the quarterly summary')
  })

  it('promotes tool images without previewImages to view.images while keeping previewImages backstage', () => {
    const view = buildReplyView(
      replyWith([
        { type: 'tool_use', id: 'chart', name: 'plot', input: {} },
        {
          type: 'tool_result',
          tool_use_id: 'chart',
          content: 'plotted',
          status: 'ok',
          images: ['data:image/png;base64,chart1', 'data:image/png;base64,chart1'],
        },
        { type: 'tool_use', id: 'snap', name: 'capture', input: {} },
        {
          type: 'tool_result',
          tool_use_id: 'snap',
          content: 'captured',
          status: 'ok',
          images: ['data:image/jpeg;base64,annotated'],
          previewImages: ['data:image/jpeg;base64,clean'],
        },
        { type: 'text', text: 'Here is the chart.' },
      ]),
      false
    )

    assert.deepEqual(view.images, ['data:image/png;base64,chart1'])
  })
})

describe('needsWorkingIndicator', () => {
  const streamingView = (blocks: AssistantMessage['blocks']) =>
    buildReplyView({ ...replyWith(blocks, true), status: 'streaming' }, true, testRegistry)
  const thought = { type: 'thinking', thinking: 'plan', startedAt: 1, endedAt: 2 } as const
  const call = { type: 'tool_use', id: 'f1', name: 'lookup', input: {} } as const

  it('shows after completed steps or open thinking blocks, hides when empty or tool is running', () => {
    assert.equal(needsWorkingIndicator(streamingView([])), false)
    assert.equal(needsWorkingIndicator(streamingView([thought, call])), false)
    assert.equal(
      needsWorkingIndicator(
        streamingView([
          call,
          { type: 'tool_result', tool_use_id: 'f1', content: '', status: 'running' },
        ])
      ),
      false
    )
    assert.equal(needsWorkingIndicator(streamingView([thought])), true)
    assert.equal(
      needsWorkingIndicator(
        streamingView([thought, { type: 'thinking', thinking: 'still thinking', startedAt: 3 }])
      ),
      true
    )
    assert.equal(
      needsWorkingIndicator(
        streamingView([
          call,
          { type: 'tool_result', tool_use_id: 'f1', content: 'ok', status: 'ok' },
        ])
      ),
      true
    )
  })
})

describe('delivered files projection', () => {
  const file = (
    id: string,
    name: string,
    extra: Partial<DeliveredFileRef> = {}
  ): DeliveredFileRef => ({
    id,
    name,
    size: 10,
    mimeType: 'text/plain',
    ...extra,
  })
  const call = (id: string, name: string) => ({ type: 'tool_use', id, name, input: {} }) as const
  const result = (id: string, files?: DeliveredFileRef[], status: 'ok' | 'error' = 'ok') =>
    ({
      type: 'tool_result',
      tool_use_id: id,
      content: '',
      status,
      ...(files ? { files } : {}),
    }) as const

  it('lists one card per file by path or name in first-seen order at latest version when settled', () => {
    const blocks: AssistantMessage['blocks'] = [
      call('c1', 'write'),
      result('c1', [file('f1', 'chart.html', { path: 'site/chart.html', version: 1 })]),
      call('c2', 'export'),
      result('c2', [file('f2', 'data.csv')]),
      call('c3', 'update'),
      result('c3', [file('f3', 'chart.html', { path: 'site/chart.html', version: 2 })]),
      call('c4', 'update'),
      result('c4', undefined, 'error'),
      { type: 'text', text: 'Here is your chart.' },
    ]
    const streaming = buildReplyView({ ...replyWith(blocks), status: 'streaming' }, true)
    assert.deepEqual(streaming.files, [])

    const settled = buildReplyView(replyWith(blocks), false)
    assert.deepEqual(
      settled.files.map((f) => [f.id, f.name, f.version]),
      [
        ['f3', 'chart.html', 2],
        ['f2', 'data.csv', undefined],
      ]
    )
  })
})

describe('buildTurnWorkStrip & getFrontStageNotes', () => {
  it('formats middot-free natural settled summaries without appending thinking duration onto tool counts', () => {
    const reply = replyWith(
      [
        { type: 'thinking', thinking: 'plan', startedAt: 0, endedAt: 5_000 },
        { type: 'tool_use', id: 's1', name: 'lookup', input: {} },
        {
          type: 'tool_result',
          tool_use_id: 's1',
          capability: 'search-cap',
          content: 'ok',
          status: 'ok',
        },
        { type: 'tool_use', id: 's2', name: 'fetch_page', input: {} },
        {
          type: 'tool_result',
          tool_use_id: 's2',
          capability: 'search-cap',
          content: 'fail',
          status: 'error',
        },
        { type: 'text', text: 'Final answer.' },
      ],
      true
    )

    const view = buildReplyView(reply, false, testRegistry)
    const strip = buildTurnWorkStrip(reply, view, false, 10_000, false, true)
    assert.equal(strip.mode, 'settled')
    if (strip.mode === 'settled') {
      assert.equal(strip.errorCount, 1)
      assert.equal(
        strip.label.includes('·'),
        false,
        'settled label must never use middot separators'
      )
      assert.match(strip.label, /1 searches/)
      assert.match(strip.label, /1 pages/)
      assert.doesNotMatch(
        strip.label,
        /error|出错/,
        'recovered mid-turn tool errors must not escalate into transcript warning copy'
      )
      assert.doesNotMatch(
        strip.label,
        /5s|5 秒/,
        'thinking duration must not be appended onto tool counts'
      )
    }

    const thinkingOnly = replyWith(
      [
        { type: 'thinking', thinking: 'weighing options', startedAt: 0, endedAt: 5_000 },
        { type: 'text', text: 'Answer.' },
      ],
      true
    )
    const thinkingStrip = buildTurnWorkStrip(
      thinkingOnly,
      buildReplyView(thinkingOnly, false, testRegistry),
      false,
      10_000,
      false,
      true
    )
    assert.equal(thinkingStrip.mode, 'settled')
    if (thinkingStrip.mode === 'settled') {
      assert.equal(thinkingStrip.thinkingOnly, true)
      assert.match(thinkingStrip.label, /5/)
    }
  })

  it('caps live parallel tracks at 3 with overflow count, emits middot-free headline, and extracts settled FrontStageNotes', () => {
    const reply: AssistantMessage = {
      ...replyWith(
        [
          { type: 'tool_use', id: 'ask1', name: 'clarify', input: {} },
          {
            type: 'tool_result',
            tool_use_id: 'ask1',
            capability: 'ask-cap',
            content: 'answered',
            status: 'ok',
            frontStageNote: {
              status: 'done',
              items: [{ id: 'theme', label: 'Theme', value: 'Editorial' }],
            },
          },
          { type: 'tool_use', id: 'sp1', name: 'spawn_worker', input: {} },
          {
            type: 'tool_result',
            tool_use_id: 'sp1',
            capability: 'parallel-cap',
            content: 'started',
            status: 'running',
          },
        ],
        true
      ),
      status: 'streaming',
      capabilityState: {
        'parallel-cap': {
          tracks: [1, 2, 3, 4, 5].map((n) => ({
            id: `w${n}`,
            label: `Worker ${n}`,
            detail: `Topic ${n}`,
            status: 'running' as const,
          })),
        },
      },
    }

    const view = buildReplyView(reply, true, testRegistry)
    const strip = buildTurnWorkStrip(reply, view, true, 5_000, false, false)
    assert.equal(strip.mode, 'live')
    if (strip.mode === 'live') {
      assert.equal(strip.liveTracks.length, 3)
      assert.equal(strip.overflowTracks, 2)
      assert.equal(strip.headline.includes('·'), false)
      assert.match(strip.headline, /5/)
    }

    const notes = getFrontStageNotes(view)
    assert.equal(notes.length, 1)
    assert.equal(notes[0]?.note.items[0]?.value, 'Editorial')
  })

  it('builds a domain-blind Tier-1 inline trace with plain summaries, inline errors, hidden-step filtering, and thinking-only prose', () => {
    const toolReply = replyWith([
      { type: 'tool_use', id: 't1', name: 'lookup', input: { summary: 'Checking Wikipedia docs' } },
      {
        type: 'tool_result',
        tool_use_id: 't1',
        capability: 'search-cap',
        content: 'ok',
        status: 'ok',
        durationMs: 1200,
      },
      { type: 'tool_use', id: 'w1', name: 'wait_workers', input: { summary: 'Waiting' } },
      {
        type: 'tool_result',
        tool_use_id: 'w1',
        capability: 'parallel-cap',
        content: 'done',
        status: 'ok',
      },
      { type: 'tool_use', id: 't2', name: 'fetch_page', input: { summary: 'Reading target page' } },
      {
        type: 'tool_result',
        tool_use_id: 't2',
        capability: 'search-cap',
        content: 'Connection timed out\nstack trace line 2',
        status: 'error',
      },
      { type: 'text', text: 'Done.' },
    ])

    const trace = buildInlineTrace(buildReplyView(toolReply, false, testRegistry))
    assert.equal(trace.items.length, 2, 'hiddenInTimeline step is omitted')
    assert.equal(trace.items[0]?.callId, 't1')
    assert.equal(trace.items[0]?.lane, 'research')
    assert.equal(trace.items[0]?.icon, 'icon-lookup')
    assert.equal(trace.items[0]?.label, 'Checking Wikipedia docs')
    assert.equal(trace.items[0]?.status, 'done')
    assert.equal(trace.items[1]?.callId, 't2')
    assert.equal(trace.items[1]?.lane, 'research')
    assert.equal(trace.items[1]?.icon, 'icon-fetch')
    assert.equal(trace.items[1]?.label, 'Reading target page')
    assert.equal(trace.items[1]?.status, 'failed')
    assert.equal(trace.items[1]?.errorText, 'Connection timed out')
    assert.equal(trace.hasRichDetails, true)

    const thinkingOnlyReply = replyWith(
      [
        { type: 'thinking', thinking: 'Weighing the tradeoffs carefully.' },
        { type: 'text', text: 'Short answer.' },
      ],
      true
    )
    const thinkingTrace = buildInlineTrace(buildReplyView(thinkingOnlyReply, false, testRegistry))
    assert.deepEqual(thinkingTrace.items, [])
    assert.equal(thinkingTrace.thinkingMarkdown, 'Weighing the tradeoffs carefully.')
    assert.equal(thinkingTrace.hasRichDetails, false)
  })

  it('shows opening steps cleanly for settled runs and retains running steps in chronological order with exact gap markers', () => {
    const makeItems = (count: number, statuses: Record<number, InlineTraceItem['status']>) =>
      Array.from({ length: count }, (_, i) => ({
        key: `s-${i}`,
        label: `Step ${i}`,
        status: statuses[i] ?? ('done' as const),
      }))

    // Short list: no truncation and no gaps.
    const short = selectInlineTracePreview(makeItems(4, { 2: 'failed' }), 6)
    assert.equal(short.hiddenCount, 0)
    assert.equal(short.entries.length, 4)
    assert.equal(
      short.entries.every((e) => !e.gapBefore),
      true
    )

    // Settled 32-step run with a recovered mid-turn error at index 26: shows opening 6 steps calmly without jumping ahead.
    const settledLong = selectInlineTracePreview(makeItems(32, { 26: 'failed' }), 6)
    assert.deepEqual(
      settledLong.entries.map((e) => [e.item.key, e.gapBefore]),
      [
        ['s-0', false],
        ['s-1', false],
        ['s-2', false],
        ['s-3', false],
        ['s-4', false],
        ['s-5', false],
      ]
    )
    assert.equal(settledLong.hiddenCount, 26)

    // Live 32-step run with a currently running step at index 31: keeps 5 opening steps + running step 31 with a gap marker.
    const liveLong = selectInlineTracePreview(makeItems(32, { 31: 'running' }), 6)
    assert.deepEqual(
      liveLong.entries.map((e) => [e.item.key, e.gapBefore]),
      [
        ['s-0', false],
        ['s-1', false],
        ['s-2', false],
        ['s-3', false],
        ['s-4', false],
        ['s-31', true],
      ]
    )
    assert.equal(liveLong.hiddenCount, 26)

    // Invariants across varied positions and caps.
    for (const total of [0, 1, 6, 7, 15, 32]) {
      for (const cap of [3, 6]) {
        const items = makeItems(total, {
          [Math.floor(total / 2)]: 'failed',
          [Math.max(0, total - 1)]: 'running',
        })
        const preview = selectInlineTracePreview(items, cap)
        assert.equal(preview.entries.length + preview.hiddenCount, items.length)
        const shownKeys = new Set(preview.entries.map((e) => e.item.key))
        for (const item of items) {
          if (item.status === 'running') {
            assert.ok(shownKeys.has(item.key), `must retain running item ${item.key}`)
          }
        }
        const indices = preview.entries.map((e) => Number(e.item.key.slice(2)))
        for (let i = 1; i < indices.length; i += 1) {
          assert.ok(indices[i] > indices[i - 1], 'must preserve chronological order')
          assert.equal(preview.entries[i].gapBefore, indices[i] > indices[i - 1] + 1)
        }
      }
    }
  })
})
