import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import type { BlobEntry } from '@deepseek-chat/spine/ports'
import { memoryBlobStore, memoryNoticePort } from '@deepseek-chat/test-support'
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

const seeded = (seed: number) => {
  let a = seed >>> 0
  return () => {
    a = (a + 0x6d2b79f5) >>> 0
    let t = a
    t = Math.imul(t ^ (t >>> 15), t | 1)
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61)
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

const IMAGE_FIXTURES: readonly {
  readonly mime: string
  readonly ext: string
  readonly header: readonly number[]
}[] = [
  { mime: 'image/png', ext: 'png', header: [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a] },
  { mime: 'image/jpeg', ext: 'jpg', header: [0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10] },
  { mime: 'image/gif', ext: 'gif', header: [0x47, 0x49, 0x46, 0x38, 0x39, 0x61] },
  {
    mime: 'image/webp',
    ext: 'webp',
    header: [0x52, 0x49, 0x46, 0x46, 0x10, 0, 0, 0, 0x57, 0x45, 0x42, 0x50],
  },
]

const visiblePromptsOf = (session: BackupSession): string[] => {
  const byId = new Map(session.messages.map((m) => [m.id, m]))
  const prompts: string[] = []
  let current = session.rootMessageId ? byId.get(session.rootMessageId) : undefined
  const seen = new Set<string>()
  while (current && !seen.has(current.id)) {
    seen.add(current.id)
    if (current.role === 'user') {
      prompts.push(current.content)
    }
    const nextId = current.selectedChildId
    current = nextId ? byId.get(nextId) : undefined
  }
  return prompts
}

describe('slice-history-backup: randomized round-trip, hostile ZIP guard, & queue serialization (SPEC 1-4)', () => {
  it('preserves multi-session trees, visible branches, and exact image bytes/MIME across randomized export-clear-import cycles', async () => {
    for (let seed = 1; seed <= 20; seed += 1) {
      const rand = seeded(seed * 919 + 17)
      const nextInt = (max: number) => Math.floor(rand() * max)
      const sessionCount = nextInt(5) // 0..4 sessions
      const expectedBlobs = new Map<string, { bytes: Uint8Array; mime: string }>()
      const initialSessions: BackupSession[] = []

      for (let sIdx = 0; sIdx < sessionCount; sIdx += 1) {
        const sid = `sess-${seed}-${sIdx}`
        const titlePool = [
          `Chat ${sIdx}`,
          `深度研究 #${sIdx}`,
          `Branch & Quotes "A/B" ${sIdx}`,
          `Topic ${seed}-${sIdx}`,
        ]
        const title = titlePool[nextInt(titlePool.length)] ?? `Chat ${sIdx}`
        const messages: BackupSession['messages'] = []
        let msgCounter = 0
        let parentId: string | null = null
        let rootMessageId: string | null = null
        const turns = 1 + nextInt(3)

        for (let t = 0; t < turns; t += 1) {
          const variants = t === 0 ? 1 + nextInt(2) : 1
          let chosenAssistantId: string | null = null
          for (let v = 0; v < variants; v += 1) {
            const uid = `${sid}-u${++msgCounter}`
            const aid = `${sid}-a${++msgCounter}`
            if (!rootMessageId) {
              rootMessageId = uid
            }
            const fileCount = nextInt(3)
            const files: Extract<BackupSession['messages'][number], { role: 'user' }>['files'] = []
            for (let f = 0; f < fileCount; f += 1) {
              const kind = IMAGE_FIXTURES[nextInt(IMAGE_FIXTURES.length)] ?? IMAGE_FIXTURES[0]
              if (!kind) {
                continue
              }
              const fid = `${sid}-img-${msgCounter}-${f}`
              const payload = new Uint8Array(kind.header.length + 8)
              payload.set(kind.header, 0)
              for (let b = kind.header.length; b < payload.length; b += 1) {
                payload[b] = nextInt(256)
              }
              expectedBlobs.set(fid, { bytes: payload, mime: kind.mime })
              files.push({
                id: fid,
                serverId: null,
                name: `photo_${f}.${kind.ext}`,
                size: payload.byteLength,
                isImage: true,
                mimeType: kind.mime,
              })
            }
            messages.push({
              id: uid,
              parentId,
              selectedChildId: aid,
              role: 'user',
              content: `Prompt s${seed} t${t} v${v} 你好\nLine 2`,
              files,
              createdAt: 1_700_000_000_000 + msgCounter * 1000,
            })
            if (parentId !== null) {
              const parentMsg = messages.find((m) => m.id === parentId)
              if (parentMsg && v === variants - 1) {
                parentMsg.selectedChildId = uid
              }
            } else if (v === variants - 1) {
              rootMessageId = uid
            }

            const blocks: Extract<
              BackupSession['messages'][number],
              { role: 'assistant' }
            >['blocks'] = []
            if (rand() < 0.5) {
              blocks.push({ type: 'thinking', thinking: `Thought ${seed}-${t}-${v}` })
            }
            if (rand() < 0.5) {
              const toolName = rand() < 0.5 ? 'calc' : 'unknown_tool'
              const callId = `call-${msgCounter}`
              blocks.push({
                type: 'tool_use',
                id: callId,
                name: toolName,
                input: { n: msgCounter },
              })
              blocks.push({
                type: 'tool_result',
                tool_use_id: callId,
                content: `res-${msgCounter}`,
                status: 'ok',
              })
            }
            blocks.push({ type: 'text', text: `Answer s${seed} t${t} v${v}` })

            messages.push({
              id: aid,
              parentId: uid,
              role: 'assistant',
              createdAt: 1_700_000_000_500 + msgCounter * 1000,
              model: 'deepseek-flash',
              thinking: blocks.some((b) => b.type === 'thinking'),
              enabledCapabilities: {},
              status: 'done',
              blocks,
            })
            if (v === variants - 1) {
              chosenAssistantId = aid
            }
          }
          parentId = chosenAssistantId
        }

        initialSessions.push({
          id: sid,
          title,
          createdAt: 1_700_000_000_000 + sIdx * 100,
          updatedAt: 1_700_000_100_000 + sIdx * 100,
          rootMessageId,
          messages,
        })
      }

      const blobs = memoryBlobStore(
        [...expectedBlobs.entries()].map(([id, entry]) => ({
          id,
          blob: new Blob([entry.bytes as Uint8Array<ArrayBuffer>], { type: entry.mime }),
        }))
      )
      let currentSessions = structuredClone(initialSessions)
      const slice = createHistoryBackupSlice({
        blobs,
        notify: memoryNoticePort(),
        now: () => new Date(2026, 10, 27),
        serializeToolBlock: (call, result) =>
          call.name === 'calc'
            ? [{ type: 'MARKDOWN', content: `\`\`\`calc\n${result?.content ?? ''}\n\`\`\`` }]
            : null,
        sessions: {
          snapshotForExport: () => ({
            summaries: currentSessions.map(({ id, title, createdAt, updatedAt }) => ({
              id,
              title,
              createdAt,
              updatedAt,
            })),
            loadSession: async (id) => currentSessions.find((s) => s.id === id),
          }),
          replaceHistory: async (prepare) => {
            const next = await prepare()
            currentSessions = [...next.sessions]
            await blobs.replaceAll(next.blobs as BlobEntry[])
            return currentSessions.length
          },
          useState: () => ({ replacing: false, empty: currentSessions.length === 0 }),
        },
      })

      // Round-trip 1: export -> clear -> import
      const exp1 = await slice.exportHistory()
      await slice.clearHistory()
      assert.equal(currentSessions.length, 0, `seed ${seed}: clearHistory emptied sessions`)
      const imported1 = await slice.importHistory(
        new File([exp1.blob], exp1.name, { type: 'application/zip' })
      )
      assert.equal(imported1, initialSessions.length, `seed ${seed}: session count round-trip 1`)

      // Round-trip 2: export -> clear -> import again (idempotence)
      const exp2 = await slice.exportHistory()
      await slice.clearHistory()
      const imported2 = await slice.importHistory(
        new File([exp2.blob], exp2.name, { type: 'application/zip' })
      )
      assert.equal(imported2, initialSessions.length, `seed ${seed}: session count round-trip 2`)

      const byId = new Map(currentSessions.map((s) => [s.id, s]))
      for (const orig of initialSessions) {
        const restored = byId.get(orig.id)
        assert.ok(restored, `seed ${seed}: missing session ${orig.id}`)
        assert.equal(restored.title, orig.title, `seed ${seed}: title mismatch for ${orig.id}`)
        assert.deepEqual(
          visiblePromptsOf(restored),
          visiblePromptsOf(orig),
          `seed ${seed}: visible branch prompts mismatch for ${orig.id}`
        )
        assert.equal(
          restored.messages.length,
          orig.messages.length,
          `seed ${seed}: total tree message count mismatch for ${orig.id}`
        )
      }

      for (const [id, expected] of expectedBlobs) {
        const actualBlob = await blobs.get(id)
        assert.ok(actualBlob, `seed ${seed}: missing blob ${id}`)
        assert.equal(
          actualBlob.type,
          expected.mime,
          `seed ${seed}: sniffed MIME mismatch for ${id}`
        )
        const actualBytes = new Uint8Array(await actualBlob.arrayBuffer())
        assert.deepEqual(
          actualBytes,
          expected.bytes,
          `seed ${seed}: exact bytes mismatch for ${id}`
        )
      }

      slice.dispose()
    }
  })

  it('rejects randomized corrupted/hostile ZIPs without calling replaceHistory on pre-flight failures and serializes concurrent queue ops', async () => {
    const baseSession = makeSession('s-guard', 'Guard Chat', [
      { type: 'text', text: 'Payload text '.repeat(12) },
    ])
    const validBlobs = memoryBlobStore([
      { id: 'img-1', blob: new Blob([pngHeader], { type: 'image/png' }) },
    ])
    let activeOps = 0
    let maxConcurrentOps = 0
    let replaceCalls = 0
    let sessions: BackupSession[] = [baseSession]

    const track = async <T>(fn: () => Promise<T>): Promise<T> => {
      activeOps += 1
      maxConcurrentOps = Math.max(maxConcurrentOps, activeOps)
      try {
        await new Promise((r) => setTimeout(r, 0))
        return await fn()
      } finally {
        activeOps -= 1
      }
    }

    const slice = createHistoryBackupSlice({
      blobs: validBlobs,
      notify: memoryNoticePort(),
      now: () => new Date(2026, 10, 27),
      sessions: {
        snapshotForExport: () => ({
          summaries: sessions.map(({ id, title, createdAt, updatedAt }) => ({
            id,
            title,
            createdAt,
            updatedAt,
          })),
          loadSession: (id) => track(async () => sessions.find((s) => s.id === id)),
        }),
        replaceHistory: (prepare) =>
          track(async () => {
            replaceCalls += 1
            const next = await prepare()
            sessions = [...next.sessions]
            await validBlobs.replaceAll(next.blobs as BlobEntry[])
            return sessions.length
          }),
        useState: () => ({ replacing: false, empty: sessions.length === 0 }),
      },
    })

    const validExport = await slice.exportHistory()
    const validBytes = new Uint8Array(await validExport.blob.arrayBuffer())

    for (let seed = 1; seed <= 40; seed += 1) {
      const rand = seeded(seed * 313 + 7)
      const nextInt = (max: number) => Math.floor(rand() * max)
      const attack = seed % 6
      const beforeReplaceCalls = replaceCalls

      if (attack === 0) {
        // Random truncation -> fails pre-flight before replaceHistory.
        const cut = 1 + nextInt(validBytes.length - 2)
        const truncated = new File([validBytes.slice(0, cut)], `trunc-${seed}.zip`)
        await assert.rejects(
          () => slice.importHistory(truncated),
          (err: unknown) => err instanceof BackupError && slice.historyErrorText(err) !== null,
          `seed ${seed}: truncated at ${cut}/${validBytes.length}`
        )
        assert.equal(
          replaceCalls,
          beforeReplaceCalls,
          `seed ${seed}: truncation must fail pre-flight`
        )
      } else if (attack === 1) {
        // Bad manifest version -> fails pre-flight before replaceHistory.
        const badVersions = [0, 1, 2, 4, '3', null]
        const badVer = badVersions[nextInt(badVersions.length)]
        const zip = await writeArchive([
          {
            name: 'manifest.json',
            blob: new Blob([JSON.stringify({ export_format_version: badVer })]),
          },
        ])
        await assert.rejects(
          () => slice.importHistory(new File([zip], `ver-${seed}.zip`)),
          (err: unknown) => err instanceof BackupError && slice.historyErrorText(err) !== null,
          `seed ${seed}: bad version ${String(badVer)}`
        )
        assert.equal(
          replaceCalls,
          beforeReplaceCalls,
          `seed ${seed}: bad version must fail pre-flight`
        )
      } else if (attack === 2) {
        // Missing manifest -> fails pre-flight before replaceHistory.
        const zip = await writeArchive([{ name: 'other.json', blob: new Blob(['{}']) }])
        await assert.rejects(
          () => slice.importHistory(new File([zip], `nomanifest-${seed}.zip`)),
          (err: unknown) => err instanceof BackupError && slice.historyErrorText(err) !== null,
          `seed ${seed}: missing manifest`
        )
        assert.equal(
          replaceCalls,
          beforeReplaceCalls,
          `seed ${seed}: missing manifest must fail pre-flight`
        )
      } else if (attack === 3) {
        // Flip a bit inside the first local entry's CRC32 (bytes 14..17) or compressed payload -> must reject.
        const mutated = validBytes.slice()
        const view = new DataView(mutated.buffer, mutated.byteOffset, mutated.byteLength)
        const nameLen = view.getUint16(26, true)
        const extraLen = view.getUint16(28, true)
        const compSize = view.getUint32(18, true)
        const dataStart = 30 + nameLen + extraLen
        const pos = compSize > 0 && rand() < 0.7 ? dataStart + nextInt(compSize) : 14 + nextInt(4)
        mutated[pos] = (mutated[pos] ?? 0) ^ (1 << nextInt(8))
        await assert.rejects(
          () => slice.importHistory(new File([mutated], `flip-${seed}.zip`)),
          (err: unknown) => err instanceof BackupError,
          `seed ${seed}: bit flip at byte ${pos}`
        )
      } else if (attack === 4) {
        // Hostile paths patched into valid ZIP -> readArchive rejects with ArchiveError.
        const origPath = 'safe/abcdef.txt'
        const hostilePaths = [
          '../escape12.txt',
          'a/../bcdefg.txt',
          'dir\\abcdefg.txt',
          'C:abcdefghi.txt',
          'bad\0abcdefg.txt',
        ]
        const hostile = hostilePaths[nextInt(hostilePaths.length)] ?? '../escape12.txt'
        const raw = new Uint8Array(
          await (await writeArchive([{ name: origPath, blob: new Blob(['ok']) }])).arrayBuffer()
        )
        const from = new TextEncoder().encode(origPath)
        const to = new TextEncoder().encode(hostile)
        assert.equal(from.length, to.length)
        for (let i = 0; i <= raw.length - from.length; i += 1) {
          if (from.every((b, j) => raw[i + j] === b)) {
            raw.set(to, i)
          }
        }
        await assert.rejects(
          async () => {
            for await (const entry of readArchive(new File([raw], `hostile-${seed}.zip`))) {
              await readEntry(entry)
            }
          },
          ArchiveError,
          `seed ${seed}: hostile path ${JSON.stringify(hostile)}`
        )
      } else {
        // Random entry/total byte budget enforcement in readArchive.
        const sizeA = 16 + nextInt(48)
        const sizeB = 16 + nextInt(48)
        const zip = await writeArchive([
          { name: 'a.txt', blob: new Blob(['a'.repeat(sizeA)]) },
          { name: 'b.txt', blob: new Blob(['b'.repeat(sizeB)]) },
        ])
        const tightTotal = sizeA + Math.floor(sizeB / 2)
        await assert.rejects(
          async () => {
            for await (const entry of readArchive(new File([zip], `cap-${seed}.zip`), {
              maxEntryBytes: Math.max(sizeA, sizeB),
              maxTotalBytes: tightTotal,
            })) {
              await readEntry(entry)
            }
          },
          ArchiveError,
          `seed ${seed}: total ${sizeA + sizeB} > cap ${tightTotal}`
        )
      }
    }

    // Randomized interleaved concurrent queue operations must never overlap.
    const queueRand = seeded(20261127)
    const tasks: Promise<unknown>[] = []
    for (let i = 0; i < 18; i += 1) {
      const r = queueRand()
      if (r < 0.4) {
        tasks.push(slice.exportHistory())
      } else if (r < 0.75) {
        tasks.push(
          slice.importHistory(
            new File([validExport.blob], validExport.name, { type: 'application/zip' })
          )
        )
      } else {
        tasks.push(slice.clearHistory())
      }
    }
    await Promise.all(tasks)
    assert.equal(maxConcurrentOps, 1, 'backup queue must serialize all export/import/clear calls')
    slice.dispose()
  })
})
