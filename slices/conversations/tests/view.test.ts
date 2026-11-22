import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import {
  buildReplyView,
  getAreaTitle,
  needsWorkingIndicator,
  type AssistantMessage,
  type PresentedFileRef,
} from '@deepseek-chat/slice-conversations'
import { installTestSlice } from './harness.js'

installTestSlice()

const replyWith = (blocks: AssistantMessage['blocks'], thinking = false): AssistantMessage => ({
  id: 'a1',
  role: 'assistant',
  createdAt: 1_000,
  model: 'deepseek-flash',
  thinking,
  search: true,
  prefix: false,
  status: 'done',
  blocks,
})

describe('buildReplyView for Firecrawl client tools', () => {
  it('maps Firecrawl web_search and web_scrape blocks to SearchStep, OpenStep, and deduplicated sources', () => {
    const view = buildReplyView(
      replyWith([
        { type: 'tool_use', id: 's1', name: 'web_search', input: { query: 'firecrawl keyless' } },
        {
          type: 'tool_result',
          tool_use_id: 's1',
          content: '[1] Firecrawl\nURL: https://firecrawl.dev',
          status: 'ok',
          searchResults: [
            {
              url: 'https://firecrawl.dev',
              title: 'Firecrawl',
              snippet: 'Keyless search API',
              siteName: 'firecrawl.dev',
              publishedAt: null,
            },
            {
              url: 'https://docs.firecrawl.dev',
              title: 'Docs',
              snippet: 'Reference',
              siteName: 'docs.firecrawl.dev',
              publishedAt: null,
            },
          ],
        },
        {
          type: 'tool_use',
          id: 's2',
          name: 'web_search',
          input: { query: 'firecrawl rate limits' },
        },
        {
          type: 'tool_result',
          tool_use_id: 's2',
          content: '[2] Docs\n[3] Rate Limits',
          status: 'ok',
          searchResults: [
            {
              url: 'https://docs.firecrawl.dev',
              title: 'Docs',
              snippet: 'Reference',
              siteName: 'docs.firecrawl.dev',
              publishedAt: null,
            },
            {
              url: 'https://docs.firecrawl.dev/rate-limits',
              title: 'Rate Limits',
              snippet: 'Daily caps',
              siteName: 'docs.firecrawl.dev',
              publishedAt: null,
            },
          ],
        },
        {
          type: 'tool_use',
          id: 'p1',
          name: 'web_scrape',
          input: { url: 'https://docs.firecrawl.dev/rate-limits' },
        },
        {
          type: 'tool_result',
          tool_use_id: 'p1',
          content: 'Title: Rate Limits | Firecrawl\n...',
          status: 'ok',
          scrapedPage: {
            url: 'https://docs.firecrawl.dev/rate-limits',
            title: 'Rate Limits | Firecrawl',
          },
        },
        { type: 'text', text: 'Keyless search is free[citation:1] with daily limits[citation:3].' },
      ]),
      false
    )

    assert.equal(view.sources.length, 3)
    assert.deepEqual(
      view.sources.map((s) => [s.index, s.url]),
      [
        [1, 'https://firecrawl.dev'],
        [2, 'https://docs.firecrawl.dev'],
        [3, 'https://docs.firecrawl.dev/rate-limits'],
      ]
    )
    assert.equal(view.searchResults.length, 3)

    const searchSteps = view.steps.filter((step) => step.type === 'search')
    assert.equal(searchSteps.length, 1)
    assert.deepEqual(searchSteps[0].queries, ['firecrawl keyless', 'firecrawl rate limits'])
    assert.equal(searchSteps[0].results.length, 3)

    const openStep = view.steps.find((step) => step.type === 'open')
    assert.ok(openStep)
    assert.equal(openStep.pages[0]?.title, 'Rate Limits | Firecrawl')
    assert.equal(openStep.pages[0]?.status, 'done')
    assert.match(view.answer?.markdown ?? '', /\[citation:1\]/)
  })

  it('groups consecutive browser_* tool calls into a BrowserStep with status and metadata', () => {
    const view = buildReplyView(
      replyWith([
        {
          type: 'tool_use',
          id: 'b1',
          name: 'browser_set_viewport',
          input: { preset: 'desktop' },
        },
        {
          type: 'tool_result',
          tool_use_id: 'b1',
          content: 'Viewport set to 1280x720',
          status: 'ok',
          durationMs: 90,
          browserAction: {
            tool: 'browser_set_viewport',
            summary: 'Viewport 1280×720 (42%)',
          },
        },
        {
          type: 'tool_use',
          id: 'b2',
          name: 'browser_navigate',
          input: { action: 'goto', url: 'https://example.com' },
        },
        {
          type: 'tool_result',
          tool_use_id: 'b2',
          content: 'Navigated to https://example.com',
          status: 'ok',
          durationMs: 420,
          browserAction: {
            tool: 'browser_navigate',
            summary: 'Opening example.com',
            url: 'https://example.com',
            title: 'Example Domain',
          },
        },
        {
          type: 'tool_use',
          id: 'b3',
          name: 'browser_click',
          input: { ref: 'e1' },
        },
        {
          type: 'tool_result',
          tool_use_id: 'b3',
          content: 'Clicked link',
          status: 'ok',
          durationMs: 280,
          images: ['data:image/jpeg;base64,abc'],
          browserAction: {
            tool: 'browser_click',
            summary: 'Clicking [e1]',
            url: 'https://example.com/more',
            title: 'More Info',
          },
        },
        { type: 'text', text: 'Done browsing.' },
      ]),
      false
    )

    const browserSteps = view.steps.filter((step) => step.type === 'browser')
    assert.equal(browserSteps.length, 1)
    assert.equal(browserSteps[0].status, 'done')
    assert.equal(browserSteps[0].actions.length, 3)
    assert.equal(browserSteps[0].actions[0]?.summary, 'Viewport 1280×720 (42%)')
    assert.equal(browserSteps[0].actions[1]?.summary, 'Opening example.com')
    assert.equal(browserSteps[0].actions[2]?.images?.[0], 'data:image/jpeg;base64,abc')
    assert.equal(view.answer?.text, 'Done browsing.')
  })

  it('groups consecutive present_file and edit_file calls into a FileStep and exposes live title', () => {
    const streamingView = buildReplyView(
      replyWith(
        [
          {
            type: 'tool_use',
            id: 'f1',
            name: 'present_file',
            input: {},
            inputJson: '{"path":"chart.html","title":"Sales Chart"',
          },
        ],
        true
      ),
      true
    )

    assert.equal(streamingView.steps.length, 1)
    assert.equal(streamingView.steps[0]?.type, 'file')
    assert.equal(streamingView.steps[0]?.status, 'wip')
    assert.match(getAreaTitle(streamingView, true, 2_000, false), /Sales Chart/)

    const doneView = buildReplyView(
      replyWith([
        {
          type: 'tool_use',
          id: 'f1',
          name: 'present_file',
          input: { path: 'chart.html', content: '<h1>1</h1>' },
        },
        {
          type: 'tool_result',
          tool_use_id: 'f1',
          content: 'Presented chart.html',
          status: 'ok',
          durationMs: 12,
          fileAction: { tool: 'present_file', path: 'chart.html', version: 1 },
          files: [
            {
              id: 'blob-1',
              name: 'chart.html',
              path: 'chart.html',
              size: 10,
              mimeType: 'text/html',
              version: 1,
              source: 'model',
            },
          ],
        },
        {
          type: 'tool_use',
          id: 'f2',
          name: 'edit_file',
          input: { path: 'chart.html', edits: [] },
        },
        {
          type: 'tool_result',
          tool_use_id: 'f2',
          content: 'Updated chart.html',
          status: 'ok',
          durationMs: 8,
          fileAction: { tool: 'edit_file', path: 'chart.html', version: 2 },
          files: [
            {
              id: 'blob-2',
              name: 'chart.html',
              path: 'chart.html',
              size: 10,
              mimeType: 'text/html',
              version: 2,
              source: 'model',
            },
          ],
        },
        { type: 'text', text: 'Chart is ready.' },
      ]),
      false
    )

    const fileSteps = doneView.steps.filter((s) => s.type === 'file')
    assert.equal(fileSteps.length, 1)
    assert.equal(fileSteps[0].status, 'done')
    assert.equal(fileSteps[0].actions.length, 2)
    assert.equal(fileSteps[0].actions[0]?.files?.[0]?.id, 'blob-1')
    assert.equal(fileSteps[0].actions[1]?.version, 2)
    assert.equal(doneView.answer?.text, 'Chart is ready.')
  })
})

describe('needsWorkingIndicator (SPEC invariant 16)', () => {
  // Views as they look while the reply is still streaming.
  const streamingView = (blocks: AssistantMessage['blocks']) =>
    buildReplyView({ ...replyWith(blocks, true), status: 'streaming' }, true)
  const thought = { type: 'thinking', thinking: 'plan', startedAt: 1, endedAt: 2 } as const
  const fileCall = { type: 'tool_use', id: 'f1', name: 'present_file', input: {} } as const

  it('shows when the last content is finished and nothing else is running', () => {
    // The captured case: thinking done, a sentence, then silence while the server writes a tool call.
    assert.equal(
      needsWorkingIndicator(streamingView([thought, { type: 'text', text: 'I will build it.' }])),
      true
    )
    // Thinking finished, nothing else yet.
    assert.equal(needsWorkingIndicator(streamingView([thought])), true)
    // A tool finished; the next request has not answered yet.
    assert.equal(
      needsWorkingIndicator(
        streamingView([
          fileCall,
          { type: 'tool_result', tool_use_id: 'f1', content: 'ok', status: 'ok' },
        ])
      ),
      true
    )
  })

  it('stays hidden while the reply has nothing yet or its last step shows it is running', () => {
    assert.equal(needsWorkingIndicator(streamingView([])), false)
    // A tool call without its result: its row already shows it is running.
    assert.equal(needsWorkingIndicator(streamingView([thought, fileCall])), false)
    assert.equal(
      needsWorkingIndicator(
        streamingView([
          { type: 'tool_use', id: 'p1', name: 'python', input: { code: '1' } },
          { type: 'tool_result', tool_use_id: 'p1', content: '', status: 'running' },
        ])
      ),
      false
    )
    // Thinking still in progress.
    assert.equal(
      needsWorkingIndicator(streamingView([{ type: 'thinking', thinking: 'hm', startedAt: 1 }])),
      false
    )
  })
})

describe('reply files (SPEC invariant 17)', () => {
  const file = (id: string, name: string, extra: Partial<PresentedFileRef> = {}) => ({
    id,
    name,
    size: 10,
    mimeType: 'text/plain',
    ...extra,
  })
  const call = (id: string, name: string) => ({ type: 'tool_use', id, name, input: {} }) as const
  const result = (id: string, files?: PresentedFileRef[], status: 'ok' | 'error' = 'ok') =>
    ({
      type: 'tool_result',
      tool_use_id: id,
      content: '',
      status,
      ...(files ? { files } : {}),
    }) as const

  it('lists one card per file in first-seen order, each at its latest version', () => {
    const view = buildReplyView(
      replyWith([
        call('c1', 'present_file'),
        result('c1', [file('f1', 'chart.html', { path: 'site/chart.html', version: 1 })]),
        call('c2', 'python'),
        result('c2', [file('f2', 'data.csv', { source: 'python' })]),
        call('c3', 'edit_file'),
        result('c3', [file('f3', 'chart.html', { path: 'site/chart.html', version: 2 })]),
        // A failed edit produces no file and leaves the latest version alone.
        call('c4', 'edit_file'),
        result('c4', undefined, 'error'),
        { type: 'text', text: 'Here is your chart.' },
      ]),
      false
    )
    assert.deepEqual(
      view.files.map((f) => [f.id, f.name, f.version]),
      [
        ['f3', 'chart.html', 2],
        ['f2', 'data.csv', undefined],
      ]
    )
    // The answer is still the answer.
    assert.equal(view.answer?.text, 'Here is your chart.')
  })

  it('tells files apart by path, and by name only when there is no path', () => {
    const view = buildReplyView(
      replyWith([
        call('c1', 'present_file'),
        result('c1', [
          file('a', 'index.html', { path: 'one/index.html' }),
          file('b', 'index.html', { path: 'two/index.html' }),
        ]),
        call('c2', 'python'),
        result('c2', [file('c', 'out.png')]),
        call('c3', 'python'),
        result('c3', [file('d', 'out.png')]),
      ]),
      false
    )
    assert.deepEqual(
      view.files.map((f) => f.id),
      ['a', 'b', 'd']
    )
  })

  it('has no files for a reply without file results', () => {
    const view = buildReplyView(replyWith([{ type: 'text', text: 'Just text.' }]), false)
    assert.deepEqual(view.files, [])
  })
})
