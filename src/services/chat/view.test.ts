import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { buildReplyView } from './view.js'
import type { AssistantMessage } from './types.js'

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
})
