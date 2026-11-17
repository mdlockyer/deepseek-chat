import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import type { Session } from '../types.js'
import { readSessionFile } from './schema.js'
import { toSessionFile } from './toArchive.js'
import { toLocalSession } from './toLocal.js'
import { ArchiveError, readArchive, readEntry } from './zipReader.js'
import { writeArchive } from './zipWriter.js'

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
