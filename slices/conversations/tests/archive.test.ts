import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import {
  ArchiveError,
  readArchive,
  readEntry,
  readSessionFile,
  toLocalSession,
  toSessionFile,
  writeArchive,
  type Session,
} from '@deepseek-chat/slice-conversations'
import { installTestSlice } from './harness.js'

installTestSlice()

const makeSession = (
  blocks: Extract<Session['messages'][number], { role: 'assistant' }>['blocks']
): Session => ({
  id: 'sess-1',
  title: 'Python session',
  createdAt: 1_700_000_000_000,
  updatedAt: 1_700_000_010_000,
  rootMessageId: 'u1',
  messages: [
    {
      id: 'u1',
      parentId: null,
      selectedChildId: 'a1',
      role: 'user',
      content: 'Compute 6 * 7',
      files: [],
      createdAt: 1_700_000_000_000,
    },
    {
      id: 'a1',
      parentId: 'u1',
      role: 'assistant',
      createdAt: 1_700_000_005_000,
      model: 'deepseek-flash',
      thinking: true,
      search: false,
      prefix: true,
      status: 'done',
      blocks,
    },
  ],
})

describe('archive export/import Python preservation', () => {
  it('preserves Python tool_use code and tool_result output as valid v3 RESPONSE Markdown', () => {
    const session = makeSession([
      { type: 'text', text: 'Running Python:' },
      {
        type: 'tool_use',
        id: 'call-1',
        name: 'python',
        input: { code: 'print(6 * 7)' },
      },
      {
        type: 'tool_result',
        tool_use_id: 'call-1',
        content: '42',
        status: 'ok',
      },
      { type: 'text', text: 'The answer is 42.' },
    ])

    const exported = toSessionFile(session, () => null)
    const validated = readSessionFile(exported)
    const reimported = toLocalSession(validated)

    const reply = reimported.session.messages[1]
    assert.equal(reply.role, 'assistant')
    const combinedText = reply.blocks
      .filter((block) => block.type === 'text')
      .map((block) => block.text)
      .join('')

    assert.match(combinedText, /Running Python:/)
    assert.match(combinedText, /```python\nprint\(6 \* 7\)\n```/)
    assert.match(combinedText, /```text\n42\n```/)
    assert.match(combinedText, /The answer is 42\./)
  })
})

describe('zipReader bounds and validation', () => {
  it('round-trips valid entries within size caps', async () => {
    const blob = await writeArchive([
      { name: 'manifest.json', blob: new Blob(['{"export_format_version":3}']) },
      { name: 'note.txt', blob: new Blob(['hello world']) },
    ])
    const file = new File([blob], 'backup.zip')
    const entries: Record<string, string> = {}
    for await (const entry of readArchive(file, { maxEntryBytes: 64, maxTotalBytes: 128 })) {
      entries[entry.path] = await (await readEntry(entry)).text()
    }
    assert.deepEqual(entries, {
      'manifest.json': '{"export_format_version":3}',
      'note.txt': 'hello world',
    })
  })

  it('rejects entries exceeding maxEntryBytes', async () => {
    const blob = await writeArchive([{ name: 'big.txt', blob: new Blob(['x'.repeat(100)]) }])
    const file = new File([blob], 'too-big-entry.zip')

    await assert.rejects(async () => {
      for await (const entry of readArchive(file, { maxEntryBytes: 50, maxTotalBytes: 500 })) {
        await readEntry(entry)
      }
    }, ArchiveError)
  })

  it('rejects archives exceeding cumulative maxTotalBytes across multiple small entries', async () => {
    const blob = await writeArchive([
      { name: 'a.txt', blob: new Blob(['a'.repeat(40)]) },
      { name: 'b.txt', blob: new Blob(['b'.repeat(40)]) },
    ])
    const file = new File([blob], 'too-big-total.zip')

    await assert.rejects(async () => {
      for await (const entry of readArchive(file, { maxEntryBytes: 50, maxTotalBytes: 60 })) {
        await readEntry(entry)
      }
    }, ArchiveError)
  })

  it('rejects path traversal entries in ZIP directory', async () => {
    const original = 'safe/name.txt'
    const traversal = '../escape.txt'
    const bytes = new Uint8Array(
      await (await writeArchive([{ name: original, blob: new Blob(['{}']) }])).arrayBuffer()
    )
    const from = new TextEncoder().encode(original)
    const to = new TextEncoder().encode(traversal)
    for (let i = 0; i <= bytes.length - from.length; i++) {
      if (from.every((b, j) => bytes[i + j] === b)) {
        bytes.set(to, i)
      }
    }
    const file = new File([bytes], 'traversal.zip')

    await assert.rejects(async () => {
      for await (const entry of readArchive(file)) {
        await readEntry(entry)
      }
    }, ArchiveError)
  })
})

describe('archive export Firecrawl preservation', () => {
  it('exports Firecrawl web_search and web_scrape blocks as TOOL_SEARCH and TOOL_OPEN fragments', () => {
    const session: Session = {
      id: 's-web',
      title: 'Web test',
      createdAt: 1_000,
      updatedAt: 2_000,
      rootMessageId: 'u1',
      messages: [
        {
          id: 'u1',
          role: 'user',
          content: 'find news',
          files: [],
          createdAt: 1_000,
          parentId: null,
          selectedChildId: 'a1',
        },
        {
          id: 'a1',
          role: 'assistant',
          createdAt: 2_000,
          model: 'deepseek-flash',
          thinking: false,
          search: true,
          prefix: false,
          status: 'done',
          parentId: 'u1',
          blocks: [
            { type: 'tool_use', id: 'ws1', name: 'web_search', input: { query: 'firecrawl' } },
            {
              type: 'tool_result',
              tool_use_id: 'ws1',
              content: '[1] Firecrawl',
              status: 'ok',
              searchResults: [
                {
                  url: 'https://firecrawl.dev',
                  title: 'Firecrawl',
                  snippet: 'Web data API',
                  siteName: 'firecrawl.dev',
                  publishedAt: null,
                },
              ],
            },
            {
              type: 'tool_use',
              id: 'sc1',
              name: 'web_scrape',
              input: { url: 'https://firecrawl.dev' },
            },
            {
              type: 'tool_result',
              tool_use_id: 'sc1',
              content: 'Title: Firecrawl',
              status: 'ok',
              scrapedPage: { url: 'https://firecrawl.dev', title: 'Firecrawl' },
            },
            { type: 'text', text: 'Found it [ref:1][ref:2]. Also [citation:1] works.' },
          ],
        },
      ],
    }

    const exported = toSessionFile(session, () => null)
    const fragments = exported.messages[1].fragments
    assert.equal(fragments[0]?.type, 'TOOL_SEARCH')
    assert.equal(fragments[1]?.type, 'TOOL_OPEN')
    assert.deepEqual(fragments[2], { type: 'RESPONSE', content: 'Found it. Also works.' })
  })
})

describe('archive export browser tool preservation', () => {
  it('exports browser_navigate as TOOL_OPEN and subsequent browser actions cleanly', () => {
    const session = makeSession([
      {
        type: 'tool_use',
        id: 'b1',
        name: 'browser_navigate',
        input: { action: 'goto', url: 'https://example.com' },
      },
      {
        type: 'tool_result',
        tool_use_id: 'b1',
        content: 'Navigated',
        status: 'ok',
        browserAction: {
          tool: 'browser_navigate',
          summary: 'Opening example.com',
          url: 'https://example.com',
          title: 'Example Domain',
        },
      },
      {
        type: 'tool_use',
        id: 'b2',
        name: 'browser_click',
        input: { ref: 'e1' },
      },
      {
        type: 'tool_result',
        tool_use_id: 'b2',
        content: 'Clicked',
        status: 'ok',
        browserAction: {
          tool: 'browser_click',
          summary: 'Clicking [e1]',
          url: 'https://example.com',
          title: 'Example Domain',
        },
      },
      { type: 'text', text: 'Finished inspecting.' },
    ])

    const exported = toSessionFile(session, () => null)
    const validated = readSessionFile(exported)
    assert.equal(validated.messages[1]?.fragments[0]?.type, 'TOOL_OPEN')
    const responseFrag = validated.messages[1]?.fragments[1]
    assert.equal(responseFrag?.type, 'RESPONSE')
    if (responseFrag?.type === 'RESPONSE') {
      assert.match(responseFrag.content, /\[Clicking \[e1\]\]/)
      assert.match(responseFrag.content, /Finished inspecting\./)
    }
  })
})

describe('archive export file presentation preservation', () => {
  it('exports present_file, edit_file, and read_file blocks as valid v3 RESPONSE Markdown', () => {
    const session = makeSession([
      {
        type: 'tool_use',
        id: 'p1',
        name: 'present_file',
        input: { path: 'app.html', title: 'Mini App', content: '<h1>Hello</h1>' },
      },
      {
        type: 'tool_result',
        tool_use_id: 'p1',
        content: 'Presented app.html',
        status: 'ok',
        fileAction: { tool: 'present_file', path: 'app.html', title: 'Mini App', version: 1 },
      },
      {
        type: 'tool_use',
        id: 'r1',
        name: 'read_file',
        input: { path: 'app.html' },
      },
      {
        type: 'tool_result',
        tool_use_id: 'r1',
        content: 'File: app.html...',
        status: 'ok',
        fileAction: { tool: 'read_file', path: 'app.html', version: 1 },
      },
      {
        type: 'tool_use',
        id: 'e1',
        name: 'edit_file',
        input: { path: 'app.html', edits: [{ old_text: 'Hello', new_text: 'World' }] },
      },
      {
        type: 'tool_result',
        tool_use_id: 'e1',
        content: 'Updated app.html',
        status: 'ok',
        fileAction: { tool: 'edit_file', path: 'app.html', version: 2 },
      },
      { type: 'text', text: 'Updated the greeting.' },
    ])

    const exported = toSessionFile(session, () => null)
    const validated = readSessionFile(exported)
    const reimported = toLocalSession(validated)
    const reply = reimported.session.messages[1]
    assert.equal(reply.role, 'assistant')
    const combined = reply.blocks
      .filter((b) => b.type === 'text')
      .map((b) => b.text)
      .join('\n')

    assert.match(combined, /\*\*Mini App\*\*/)
    assert.match(combined, /```html\n<h1>Hello<\/h1>\n```/)
    assert.match(combined, /\[Updated app\.html \(v2\)\]/)
    assert.match(combined, /Updated the greeting\./)
  })
})
