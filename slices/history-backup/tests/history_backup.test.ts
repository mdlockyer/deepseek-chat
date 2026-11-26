import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { memoryBlobStore, memoryNoticePort, type BlobEntry } from '@deepseek-chat/spine/ports'
import {
  ArchiveError,
  BackupError,
  createHistoryBackupSlice,
  readArchive,
  readEntry,
  readSessionFile,
  toLocalSession,
  toSessionFile,
  writeArchive,
  type BackupSession,
} from '@deepseek-chat/slice-history-backup'

const pngHeader = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 0])

const makeSession = (
  id: string,
  title: string,
  blocks: Extract<BackupSession['messages'][number], { role: 'assistant' }>['blocks']
): BackupSession => ({
  id,
  title,
  createdAt: 1_700_000_000_000,
  updatedAt: 1_700_000_010_000,
  rootMessageId: 'u1',
  messages: [
    {
      id: 'u1',
      parentId: null,
      selectedChildId: 'a1',
      role: 'user',
      content: 'Hello',
      files: [
        {
          id: 'img-1',
          serverId: null,
          name: 'pic.png',
          size: pngHeader.byteLength,
          isImage: true,
          mimeType: 'image/png',
        },
      ],
      createdAt: 1_700_000_000_000,
    },
    {
      id: 'a1',
      parentId: 'u1',
      role: 'assistant',
      createdAt: 1_700_000_005_000,
      model: 'deepseek-flash',
      thinking: true,
      enabledCapabilities: { 'web-research': true },
      prefix: true,
      status: 'done',
      blocks,
    },
  ],
})

describe('slice-history-backup: round-trip export, import, clear, and custom serializer', () => {
  it('exports, re-imports, preserves images, delegates tool serialization, and clears cleanly', async () => {
    const blobs = memoryBlobStore([
      { id: 'img-1', blob: new Blob([pngHeader], { type: 'image/png' }) },
    ])
    let sessions: BackupSession[] = [
      makeSession('sess-1', 'Custom Tool Chat', [
        { type: 'text', text: 'Before tool.' },
        { type: 'tool_use', id: 'c1', name: 'calc', input: { expr: '6*7' } },
        { type: 'tool_result', tool_use_id: 'c1', content: '42', status: 'ok' },
        { type: 'text', text: 'After tool.' },
      ]),
    ]

    const slice = createHistoryBackupSlice({
      blobs,
      notify: memoryNoticePort(),
      now: () => new Date(2026, 10, 24),
      serializeToolBlock: (call, result) =>
        call.name === 'calc'
          ? [{ type: 'MARKDOWN', content: `\`\`\`calc\n6*7 = ${result?.content ?? ''}\n\`\`\`` }]
          : null,
      sessions: {
        snapshotForExport: () => ({
          summaries: sessions.map(({ id, title, createdAt, updatedAt }) => ({
            id,
            title,
            createdAt,
            updatedAt,
          })),
          loadSession: async (id) => sessions.find((s) => s.id === id),
        }),
        replaceHistory: async (prepare) => {
          const next = await prepare()
          sessions = [...next.sessions]
          await blobs.replaceAll(next.blobs as BlobEntry[])
          return sessions.length
        },
        useState: () => ({ replacing: false, empty: sessions.length === 0 }),
      },
    })

    const exported = await slice.exportHistory()
    assert.equal(exported.name, 'deepseek_data-2026-11-24.zip')

    // Clear all history first
    await slice.clearHistory()
    assert.equal(sessions.length, 0)
    assert.equal(await blobs.get('img-1'), undefined)

    // Re-import the exported ZIP
    const importedCount = await slice.importHistory(
      new File([exported.blob], exported.name, { type: 'application/zip' })
    )
    assert.equal(importedCount, 1)
    assert.equal(sessions[0]?.title, 'Custom Tool Chat')
    assert.equal(sessions[0]?.messages[0]?.role, 'user')
    if (sessions[0]?.messages[0]?.role === 'user') {
      assert.equal(sessions[0].messages[0].files[0]?.mimeType, 'image/png')
    }
    const restoredBlob = await blobs.get('img-1')
    assert.ok(restoredBlob)
    assert.equal(restoredBlob.type, 'image/png')

    const reply = sessions[0]?.messages[1]
    assert.equal(reply?.role, 'assistant')
    if (reply?.role === 'assistant') {
      const text = reply.blocks
        .filter((b) => b.type === 'text')
        .map((b) => b.text)
        .join('')
      assert.match(text, /```calc\n6\*7 = 42\n```/)
    }

    // Rejects invalid ZIP before invoking replaceHistory
    let replaceCalled = false
    const guardSlice = createHistoryBackupSlice({
      blobs: memoryBlobStore(),
      sessions: {
        snapshotForExport: () => ({ summaries: [], loadSession: async () => undefined }),
        replaceHistory: async () => {
          replaceCalled = true
          return 0
        },
        useState: () => ({ replacing: false, empty: true }),
      },
    })
    await assert.rejects(
      () => guardSlice.importHistory(new File(['not a zip'], 'bad.zip')),
      (error: unknown) =>
        error instanceof BackupError && guardSlice.historyErrorText(error) !== null
    )
    assert.equal(replaceCalled, false)

    slice.dispose()
    guardSlice.dispose()
  })

  it('keeps pure zip and session codecs working within bounds', async () => {
    const session = makeSession('s1', 'Pure', [
      { type: 'tool_use', id: 'c1', name: 'unknown_tool', input: { code: 'x = 1' } },
      { type: 'tool_result', tool_use_id: 'c1', content: 'ok', status: 'ok' },
    ])
    const exported = toSessionFile(session, () => null)
    const local = toLocalSession(readSessionFile(exported))
    assert.equal(local.session.id, 's1')

    const zip = await writeArchive([
      { name: 'manifest.json', blob: new Blob(['{"export_format_version":3}']) },
      { name: 'note.txt', blob: new Blob(['hello']) },
    ])
    const entries: Record<string, string> = {}
    for await (const entry of readArchive(new File([zip], 'test.zip'), {
      maxEntryBytes: 64,
      maxTotalBytes: 128,
    })) {
      entries[entry.path] = await (await readEntry(entry)).text()
    }
    assert.equal(entries['note.txt'], 'hello')

    await assert.rejects(async () => {
      for await (const entry of readArchive(new File([zip], 'test.zip'), { maxEntryBytes: 2 })) {
        await readEntry(entry)
      }
    }, ArchiveError)

    // Cumulative maxTotalBytes cap
    const multiZip = await writeArchive([
      { name: 'a.txt', blob: new Blob(['a'.repeat(40)]) },
      { name: 'b.txt', blob: new Blob(['b'.repeat(40)]) },
    ])
    await assert.rejects(async () => {
      for await (const entry of readArchive(new File([multiZip], 'multi.zip'), {
        maxEntryBytes: 50,
        maxTotalBytes: 60,
      })) {
        await readEntry(entry)
      }
    }, ArchiveError)

    // Path traversal rejection
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
    await assert.rejects(async () => {
      for await (const entry of readArchive(new File([bytes], 'traversal.zip'))) {
        await readEntry(entry)
      }
    }, ArchiveError)
  })

  it('imports TOOL_SEARCH and TOOL_OPEN as client web-research blocks with sources and ignores legacy READ_LINK and TOOL_FIND', () => {
    const local = toLocalSession(
      readSessionFile({
        id: 'legacy-search-session',
        title: 'Research Archive',
        pinned: false,
        current_message_id: 2,
        inserted_at: '2026-04-01T00:00:00.000Z',
        updated_at: '2026-04-01T00:01:00.000Z',
        messages: [
          {
            id: 1,
            parent_id: null,
            role: 'USER',
            status: 'FINISHED',
            thinking_enabled: false,
            search_enabled: true,
            accumulated_token_usage: 0,
            inserted_at: '2026-04-01T00:00:00.000Z',
            fragments: [{ type: 'REQUEST', content: 'Find specs' }],
          },
          {
            id: 2,
            parent_id: 1,
            role: 'ASSISTANT',
            status: 'FINISHED',
            thinking_enabled: false,
            search_enabled: true,
            accumulated_token_usage: 120,
            inserted_at: '2026-04-01T00:00:10.000Z',
            fragments: [
              {
                type: 'TOOL_SEARCH',
                status: 'FINISHED',
                queries: ['standard messages api'],
                results: [
                  {
                    url: 'https://docs.example/api',
                    title: 'Messages API',
                    snippet: 'Standard schema',
                    published_at: null,
                    site_name: 'docs.example',
                    site_icon: null,
                  },
                ],
              },
              {
                type: 'TOOL_OPEN',
                status: 'FINISHED',
                url: 'https://docs.example/guide',
                title: 'Guide',
                snippet: '',
                site_name: 'docs.example',
                published_at: null,
              },
              { type: 'TOOL_FIND', status: 'FINISHED', pattern: 'ignored' },
              {
                type: 'READ_LINK',
                results: [{ url: 'https://legacy.example', title: 'Legacy', signature: 'sig' }],
              },
              { type: 'RESPONSE', content: 'Done.' },
            ],
          },
        ],
      })
    )

    const assistantMsg = local.session.messages[1]
    assert.equal(assistantMsg?.role, 'assistant')
    if (assistantMsg?.role === 'assistant') {
      assert.deepEqual(
        assistantMsg.blocks.map((b) => (b.type === 'tool_use' ? `${b.type}:${b.name}` : b.type)),
        ['tool_use:web_search', 'tool_result', 'tool_use:web_scrape', 'tool_result', 'text']
      )
      const searchResult = assistantMsg.blocks[1]
      assert.equal(searchResult?.type, 'tool_result')
      if (searchResult?.type === 'tool_result') {
        assert.equal(searchResult.capability, 'web-research')
        assert.equal(searchResult.sources?.[0]?.url, 'https://docs.example/api')
      }
      const openResult = assistantMsg.blocks[3]
      assert.equal(openResult?.type, 'tool_result')
      if (openResult?.type === 'tool_result') {
        assert.equal(openResult.capability, 'web-research')
        assert.equal(openResult.sources?.[0]?.url, 'https://docs.example/guide')
      }
    }
  })
})
