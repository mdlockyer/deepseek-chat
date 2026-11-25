import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import type { PanelLayout, PanelSlot } from '@deepseek-chat/spine/ports'
import type { SessionDeleted, SessionHistoryReplaced } from '@deepseek-chat/spine/facts/session'
import { EventLog } from '@deepseek-chat/spine/runtime'
import {
  classifyPreviewKind,
  collectWorkspaceArtifacts,
  createWorkspaceFilesSlice,
  getCodeLanguage,
  inferMimeType,
  makeArtifactKey,
  makeUploadPreviewKey,
  normalizeWorkspacePath,
  parseDelimitedText,
  supportsPreviewToggle,
  type FileRecord,
  type PreviewToolRunResult,
} from '@deepseek-chat/slice-workspace-files'

// ---------- fakes ----------

/** The app's right panel, reduced to what a slot sees: which chats show this kind, and who is on screen. */
const fakePanel = (activeSessionId: string | null = 's1') => {
  const shown = new Set<string>()
  let layout: PanelLayout = {
    activeSessionId,
    animating: false,
    resizing: false,
    overlayLocked: false,
    width: 540,
  }
  const slot: PanelSlot = {
    useStageSize: () => null,
    setStageSize: () => {},
    setResizing: (resizing) => {
      layout = { ...layout, resizing }
    },
    isResizing: () => layout.resizing,
    isOpen: (sessionId) => sessionId !== null && shown.has(sessionId),
    open: (sessionId) => {
      shown.add(sessionId)
    },
    close: (sessionId) => {
      shown.delete(sessionId)
    },
    setAnimating: (animating) => {
      layout = { ...layout, animating }
    },
    getLayout: () => layout,
    subscribe: () => () => {},
    useLayout: (select) => select(layout),
  }
  return { slot, shown }
}

const noViews = {
  Markdown: () => null,
  Mermaid: () => null,
  useHighlight: () => null,
  FileIcon: () => null,
}

/** A slice over an in-memory file store; `store` holds what the chat would have saved. */
const setup = (activeSessionId: string | null = 's1') => {
  const panel = fakePanel(activeSessionId)
  const log = new EventLog()
  const store = new Map<string, Blob>()
  let counter = 0
  const files = createWorkspaceFilesSlice({
    log,
    panel: panel.slot,
    host: null,
    loadFile: async (id) => store.get(id),
    saveFile: async () => {},
    copyText: async () => true,
    views: noViews,
    newId: () => `id${++counter}`,
  })
  return { files, panel, log, store }
}

/** What the chat does with a presented file: store the blob, then record it in the reply. */
const keep = (
  store: Map<string, Blob>,
  records: FileRecord[],
  result: PreviewToolRunResult,
  producedBy: string,
  createdAt: number
) => {
  assert.ok(result.file, `expected a file, got: ${result.text}`)
  store.set(result.file.ref.id, result.file.blob)
  const { id, ...ref } = result.file.ref
  records.push({
    kind: 'presented',
    fileId: id,
    ...ref,
    producedBy,
    messageId: `m${createdAt}`,
    createdAt,
  })
}

const upload = (fileId: string, name: string, size: number, mimeType: string): FileRecord => ({
  kind: 'upload',
  fileId,
  name,
  size,
  mimeType,
  messageId: 'u1',
  createdAt: 1_000,
})

const presented = (
  fileId: string,
  path: string,
  extra: Partial<Extract<FileRecord, { kind: 'presented' }>> = {}
): FileRecord => ({
  kind: 'presented',
  fileId,
  name: path.split('/').at(-1) ?? path,
  path,
  size: 10,
  mimeType: inferMimeType(path),
  messageId: 'a1',
  createdAt: 2_000,
  ...extra,
})

/** A reply after every recorded one: each call below stands for a new reply. */
const NEXT_REPLY = 'next-reply'

// ---------- tests ----------

describe('workspace-files: tool declaration', () => {
  it('declares exactly the three file tools and their instructions', () => {
    const { files } = setup()
    assert.deepEqual(
      files.declareTools().map((tool) => tool.name),
      ['present_file', 'edit_file', 'read_file']
    )
    assert.equal(files.handles('edit_file'), true)
    assert.equal(files.handles('python'), false)
    assert.match(files.instructions, /`present_file`, `edit_file`, `read_file`/)
  })
})

describe('workspace-files: file-format rules', () => {
  it('infers MIME types from extensions while preserving explicit non-generic types', () => {
    assert.equal(inferMimeType('app.html'), 'text/html')
    assert.equal(inferMimeType('diagram.svg'), 'image/svg+xml')
    assert.equal(inferMimeType('data.csv'), 'text/csv')
    assert.equal(inferMimeType('notes.md', 'application/octet-stream'), 'text/markdown')
    assert.equal(inferMimeType('custom.txt', 'text/csv; charset=utf-8'), 'text/csv')
    assert.equal(inferMimeType('unknown.bin'), 'application/octet-stream')
  })

  it('classifies preview kinds and toggle availability', () => {
    assert.equal(classifyPreviewKind('page.html', 'text/html'), 'html')
    assert.equal(classifyPreviewKind('chart.svg', 'image/svg+xml'), 'svg')
    assert.equal(classifyPreviewKind('photo.png', 'image/png'), 'image')
    assert.equal(classifyPreviewKind('doc.md', 'text/markdown'), 'markdown')
    assert.equal(classifyPreviewKind('flow.mmd', 'text/plain'), 'mermaid')
    assert.equal(classifyPreviewKind('metrics.tsv', 'text/tab-separated-values'), 'table')
    assert.equal(classifyPreviewKind('deck.pdf', 'application/pdf'), 'pdf')
    assert.equal(classifyPreviewKind('Dockerfile', ''), 'code')
    assert.equal(classifyPreviewKind('archive.zip', 'application/zip'), 'binary')

    for (const kind of ['html', 'svg', 'markdown', 'table'] as const) {
      assert.equal(supportsPreviewToggle(kind), true, kind)
    }
    for (const kind of ['code', 'image', 'pdf', 'binary'] as const) {
      assert.equal(supportsPreviewToggle(kind), false, kind)
    }
  })

  it('maps extensions and MIME types to highlight language names', () => {
    assert.equal(getCodeLanguage('widget.tsx', ''), 'tsx')
    assert.equal(getCodeLanguage('script.py', ''), 'python')
    assert.equal(getCodeLanguage('data', 'application/json'), 'json')
    assert.equal(getCodeLanguage('notes.unknown', 'text/plain'), 'text')
  })

  it('parses RFC-4180 CSV with quotes, escaped quotes, embedded newlines, CRLF, BOM, padding and truncation', () => {
    const csv =
      '\uFEFF"Name","Notes","Value"\r\n' +
      '"Alice, A.","Line 1\n""Line 2""",100\r\n' +
      '"Bob","Short"\r\n' +
      '"Charlie","Third",300\r\n'

    const parsed = parseDelimitedText(csv, ',', 2)
    assert.deepEqual(parsed.headers, ['Name', 'Notes', 'Value'])
    assert.deepEqual(parsed.rows, [
      ['Alice, A.', 'Line 1\n"Line 2"', '100'],
      ['Bob', 'Short', ''],
    ])
    assert.equal(parsed.truncated, true)
    // Exactly at the limit: three data rows, nothing cut (the header does not count).
    assert.equal(parseDelimitedText(csv, ',', 3).truncated, false)
    assert.equal(parseDelimitedText(csv, ',', 3).rows.length, 3)
  })
})

describe('workspace-files: paths and artifacts', () => {
  it('normalizes paths so they cannot climb out of the workspace', () => {
    assert.equal(normalizeWorkspacePath('/./charts/../reports//q4.md'), 'charts/reports/q4.md')
    assert.equal(normalizeWorkspacePath('..\\app.html'), 'app.html')
    assert.equal(normalizeWorkspacePath('   '), '')
    assert.equal(makeArtifactKey('/a//b.md'), makeArtifactKey('a/b.md'))
  })

  it('groups versions by path in order, takes the latest title, and infers python as a source', () => {
    const records: FileRecord[] = [
      upload('up-1', 'notes.txt', 12, 'text/plain'),
      presented('f1', 'app.html', { version: 1, source: 'model', producedBy: 'present_file' }),
      // No path: the name is the path.
      {
        kind: 'presented',
        fileId: 'py1',
        name: 'out.csv',
        size: 40,
        mimeType: 'text/csv',
        producedBy: 'python',
        messageId: 'a1',
        createdAt: 2_000,
      },
      // A later reply (same-reply saves are one version; see the per-reply tests).
      presented('f2', './app.html', {
        title: 'Interactive App',
        producedBy: 'edit_file',
        messageId: 'a2',
      }),
    ]

    const artifacts = collectWorkspaceArtifacts(records)
    assert.deepEqual(
      artifacts.map((a) => a.path),
      ['app.html', 'out.csv']
    )
    const [app, csv] = artifacts
    // f2 has no version number and comes from a later reply, so v2.
    assert.deepEqual(
      app?.versions.map((v) => [v.fileId, v.version]),
      [
        ['f1', 1],
        ['f2', 2],
      ]
    )
    assert.equal(app?.latest.fileId, 'f2')
    assert.equal(app?.title, 'Interactive App')
    assert.equal(csv?.source, 'python')
    assert.equal(csv?.latest.fileId, 'py1')
  })
})

describe('workspace-files: present, edit and read', () => {
  it('versions a path across present and edit without touching earlier versions', async () => {
    const { files, store } = setup()
    const records: FileRecord[] = []

    const v1 = await files.run(
      'present_file',
      { path: 'charts/sales.html', content: '<h1>v1</h1>', title: 'Sales Chart' },
      { records, replyId: NEXT_REPLY }
    )
    assert.equal(v1.status, 'ok')
    assert.equal(v1.file?.ref.version, 1)
    assert.equal(v1.file?.ref.path, 'charts/sales.html')
    assert.equal(v1.file?.ref.name, 'sales.html')
    assert.equal(v1.file?.ref.mimeType, 'text/html')
    assert.equal(v1.file?.artifactKey, makeArtifactKey('charts/sales.html'))
    keep(store, records, v1, 'present_file', 1_000)

    const v2 = await files.run(
      'edit_file',
      { path: 'sales.html', edits: [{ old_text: '<h1>v1</h1>', new_text: '<h1>v2</h1>' }] },
      { records, replyId: NEXT_REPLY }
    )
    assert.equal(v2.status, 'ok')
    assert.equal(v2.file?.ref.version, 2)
    assert.equal(v2.file?.ref.path, 'charts/sales.html')
    assert.equal(v2.file?.ref.title, 'Sales Chart', 'title carried over')
    assert.notEqual(v2.file?.ref.id, v1.file?.ref.id)
    keep(store, records, v2, 'edit_file', 2_000)

    assert.equal(await store.get(v1.file?.ref.id ?? '')?.text(), '<h1>v1</h1>')
    assert.equal(await store.get(v2.file?.ref.id ?? '')?.text(), '<h1>v2</h1>')

    const read = await files.run(
      'read_file',
      { path: 'charts/sales.html' },
      { records, replyId: NEXT_REPLY }
    )
    assert.equal(read.status, 'ok')
    assert.match(read.text, /^File: charts\/sales\.html \(v2, text\/html/)
    assert.match(read.text, /<h1>v2<\/h1>$/)

    // Presenting the same path again continues the numbering.
    const v3 = await files.run(
      'present_file',
      { path: '/charts/sales.html', content: 'x' },
      { records, replyId: NEXT_REPLY }
    )
    assert.equal(v3.file?.ref.version, 3)
  })

  it('applies edits in order, each to the result of the previous one', async () => {
    const { files, store } = setup()
    const records: FileRecord[] = []
    keep(
      store,
      records,
      await files.run(
        'present_file',
        { path: 'a.js', content: 'const a = 1\nconst b = 2\n' },
        { records, replyId: NEXT_REPLY }
      ),
      'present_file',
      1_000
    )
    const edited = await files.run(
      'edit_file',
      {
        path: 'a.js',
        edits: [
          { old_text: 'const a = 1', new_text: 'const a = 10' },
          { old_text: 'a = 10\nconst b = 2', new_text: 'a = 10\nconst b = 20' },
        ],
      },
      { records, replyId: NEXT_REPLY }
    )
    assert.equal(edited.status, 'ok')
    assert.equal(await edited.file?.blob.text(), 'const a = 10\nconst b = 20\n')
    assert.match(edited.text, /\(2 edits,/)
  })

  it('rejects edits that are missing, ambiguous, empty, or aimed at uploads', async () => {
    const { files, store } = setup()
    const records: FileRecord[] = [upload('up', 'notes.txt', 3, 'text/plain')]
    store.set('up', new Blob(['abc']))
    keep(
      store,
      records,
      await files.run(
        'present_file',
        { path: 't.js', content: 'foo\nfoo' },
        { records, replyId: NEXT_REPLY }
      ),
      'present_file',
      1_000
    )
    const edit = (path: string, edits: unknown) =>
      files.run('edit_file', { path, edits }, { records, replyId: NEXT_REPLY })

    const missing = await edit('t.js', [{ old_text: 'nope', new_text: 'x' }])
    assert.equal(missing.status, 'error')
    assert.match(missing.text, /Edit #1 old_text not found in "t\.js"/)

    const ambiguous = await edit('t.js', [{ old_text: 'foo', new_text: 'bar' }])
    assert.match(ambiguous.text, /Edit #1 old_text matched 2 places/)

    const empty = await edit('t.js', [{ old_text: '', new_text: 'x' }])
    assert.match(empty.text, /Edit #1 has empty old_text/)

    const none = await edit('t.js', [])
    assert.match(none.text, /edits must be a non-empty array/)

    const toUpload = await edit('notes.txt', [{ old_text: 'abc', new_text: 'x' }])
    assert.equal(toUpload.status, 'error')
    assert.match(toUpload.text, /Presented file "notes\.txt" was not found/)

    for (const result of [missing, ambiguous, empty, none, toUpload]) {
      assert.equal(result.file, undefined)
    }
  })

  it('reads uploads and finds files case-insensitively', async () => {
    const { files, store } = setup()
    const records: FileRecord[] = [
      upload('up', 'notes.txt', 5, 'text/plain'),
      presented('f1', 'App.html', { version: 1 }),
    ]
    store.set('up', new Blob(['hello']))
    store.set('f1', new Blob(['<p>']))

    const note = await files.run(
      'read_file',
      { path: 'notes.txt' },
      { records, replyId: NEXT_REPLY }
    )
    assert.equal(note.status, 'ok')
    assert.match(note.text, /hello$/)
    const app = await files.run('read_file', { path: 'APP.HTML' }, { records, replyId: NEXT_REPLY })
    assert.match(app.text, /^File: App\.html \(v1/)
  })

  it('cuts read_file output after 40,000 characters and rejects binary files', async () => {
    const { files, store } = setup()
    const records: FileRecord[] = [
      upload('big', 'big.txt', 45_000, 'text/plain'),
      upload('edge', 'edge.txt', 40_000, 'text/plain'),
      upload('img', 'pic.png', 3, 'image/png'),
    ]
    store.set('big', new Blob(['x'.repeat(45_000)]))
    store.set('edge', new Blob(['y'.repeat(40_000)]))
    store.set('img', new Blob([new Uint8Array([1, 2, 3])]))

    const big = await files.run('read_file', { path: 'big.txt' }, { records, replyId: NEXT_REPLY })
    assert.equal(big.status, 'ok')
    assert.match(big.text, /\[Truncated after 40,000 of 45,000 characters\]$/)
    assert.ok(big.text.includes('x'.repeat(40_000)))
    assert.ok(!big.text.includes('x'.repeat(40_001)))

    const edge = await files.run(
      'read_file',
      { path: 'edge.txt' },
      { records, replyId: NEXT_REPLY }
    )
    assert.doesNotMatch(edge.text, /Truncated/)

    const img = await files.run('read_file', { path: 'pic.png' }, { records, replyId: NEXT_REPLY })
    assert.equal(img.status, 'error')
    assert.match(img.text, /not a UTF-8 text file/)
  })

  it('rejects content over 10 MB, empty paths, and missing content', async () => {
    const { files } = setup()
    const limit = 10 * 1024 * 1024
    const atLimit = await files.run(
      'present_file',
      { path: 'a.txt', content: 'a'.repeat(limit) },
      { records: [], replyId: NEXT_REPLY }
    )
    assert.equal(atLimit.status, 'ok')
    const over = await files.run(
      'present_file',
      { path: 'a.txt', content: 'a'.repeat(limit + 1) },
      { records: [], replyId: NEXT_REPLY }
    )
    assert.equal(over.status, 'error')
    assert.match(over.text, /exceeds the .* text preview limit/)

    const noPath = await files.run(
      'present_file',
      { path: '../..', content: 'x' },
      { records: [], replyId: NEXT_REPLY }
    )
    assert.equal(noPath.status, 'error')
    assert.match(noPath.text, /path must be a non-empty relative file path/)

    const noContent = await files.run(
      'present_file',
      { path: 'a.txt', title: 'Notes' },
      { records: [], replyId: NEXT_REPLY }
    )
    assert.equal(noContent.status, 'error')
    assert.equal(noContent.file, undefined)
    // The model learns what was missing and what its call did contain.
    assert.match(noContent.text, /`content`/)
    assert.match(noContent.text, /only had: path, title\b/)
  })
})

describe('workspace-files: preview state', () => {
  it('tracks the active file and version pins per chat', () => {
    const { files, panel } = setup('s1')
    const keyA = makeArtifactKey('a.html')

    // Opening historical version f1 pins it and opens the panel.
    files.openFile('s1', keyA, 'f1', false)
    assert.equal(panel.slot.isOpen('s1'), true)
    assert.equal(files.getSession('s1').activeKey, keyA)
    assert.equal(files.getSession('s1').selectedFileIdByKey[keyA], 'f1')

    // Revealing a new version clears the pin.
    files.reveal('s1', keyA, { openPanel: true })
    assert.equal(files.getSession('s1').selectedFileIdByKey[keyA], undefined)

    // Opening the latest version never pins.
    files.openFile('s1', keyA, 'f2', true)
    assert.equal(files.getSession('s1').selectedFileIdByKey[keyA], undefined)

    assert.deepEqual(files.getSession('never-seen'), {
      activeKey: null,
      uploadKeys: [],
      selectedFileIdByKey: {},
      viewModeByKey: {},
      viewportByKey: {},
    })
  })

  it('opens the panel on reveal only for the chat on screen, unless told', () => {
    const { files, panel } = setup('s1')
    const keyB = makeArtifactKey('b.md')

    files.reveal('s2', keyB)
    assert.equal(panel.slot.isOpen('s2'), false, 'background chat')
    assert.equal(files.getSession('s2').activeKey, keyB)
    assert.equal(files.getSession('s1').activeKey, null, 'chat on screen untouched')

    files.reveal('s1', keyB)
    assert.equal(panel.slot.isOpen('s1'), true)

    files.reveal('s3', keyB, { openPanel: true })
    assert.equal(panel.slot.isOpen('s3'), true)
  })

  it('toggles: closes when open; reopens on a still-valid file, else the last given key', () => {
    const { files, panel } = setup('s1')
    const keyA = makeArtifactKey('a.html')
    const keyB = makeArtifactKey('b.md')
    const uploadKey = makeUploadPreviewKey('up')

    files.togglePanel('s1', [keyA, keyB])
    assert.equal(panel.slot.isOpen('s1'), true)
    assert.equal(files.getSession('s1').activeKey, keyB, 'no active file: last key')

    files.togglePanel('s1', [keyA, keyB])
    assert.equal(panel.slot.isOpen('s1'), false)

    files.openFile('s1', keyA)
    files.closePanel('s1')
    files.togglePanel('s1', [keyA, keyB])
    assert.equal(files.getSession('s1').activeKey, keyA, 'still valid: kept')

    // An opened upload stays valid even though it is not an artifact key.
    files.openFile('s1', uploadKey, 'up')
    assert.deepEqual(files.getSession('s1').uploadKeys, [uploadKey])
    files.closePanel('s1')
    files.togglePanel('s1', [keyA])
    assert.equal(files.getSession('s1').activeKey, uploadKey)

    // A file that left the branch falls back to the last given key.
    files.reveal('s1', makeArtifactKey('gone.txt'))
    files.closePanel('s1')
    files.togglePanel('s1', [keyA, keyB])
    assert.equal(files.getSession('s1').activeKey, keyB)
  })

  it('drops a deleted chat on SessionDeleted and every chat on SessionHistoryReplaced', () => {
    const { files, log } = setup('s1')
    const key = makeArtifactKey('a.html')
    files.reveal('s1', key, { openPanel: false })
    files.reveal('s2', key, { openPanel: false })

    log.publish<SessionDeleted>({ type: 'SessionDeleted', sessionId: 's1' })
    assert.equal(files.getSession('s1').activeKey, null)
    assert.equal(files.getSession('s2').activeKey, key)

    log.publish<SessionHistoryReplaced>({ type: 'SessionHistoryReplaced' })
    assert.equal(files.getSession('s2').activeKey, null)
  })
})

/** A tiny seeded PRNG (mulberry32) for reproducible randomized invariants. */
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

describe('workspace-files: a version is what one reply left a file as (SPEC 2–4)', () => {
  it('numbers saves per reply and lists one version per reply (randomized)', async () => {
    const PATHS = ['page.html', 'notes/report.md', 'data.csv']
    for (let seed = 1; seed <= 30; seed += 1) {
      const random = seeded(seed)
      const pick = <T>(items: readonly T[]) => items[Math.floor(random() * items.length)] as T
      const { files, store } = setup()
      const records: FileRecord[] = []
      // Reference model, per path: the replies that saved it (in order) and its current text.
      const savedBy = new Map<string, string[]>()
      const text = new Map<string, string>()
      // Per path: the text each reply left it with, in reply order.
      const leftAs = new Map<string, string[]>()
      let createdAt = 0

      for (let reply = 1; reply <= 6; reply += 1) {
        const replyId = `reply-${seed}-${reply}`
        const saves = 1 + Math.floor(random() * 3)
        for (let save = 0; save < saves; save += 1) {
          const path = pick(PATHS)
          const next = `${path} by ${replyId} save ${save}`
          const current = text.get(path)
          const edit = current !== undefined && random() < 0.6
          const result = edit
            ? await files.run(
                'edit_file',
                { path, edits: [{ old_text: current, new_text: next }] },
                { records, replyId }
              )
            : await files.run('present_file', { path, content: next }, { records, replyId })
          assert.equal(result.status, 'ok', result.text)

          const replies = savedBy.get(path) ?? []
          const revised = replies.at(-1) === replyId
          if (!revised) {
            replies.push(replyId)
            leftAs.set(path, [...(leftAs.get(path) ?? []), next])
          } else {
            leftAs.get(path)?.splice(-1, 1, next)
          }
          savedBy.set(path, replies)
          text.set(path, next)
          // Its number counts the replies that saved the path, this one included.
          const expected = replies.length
          const where = `seed ${seed}, ${replyId}, save ${save} (${edit ? 'edit' : 'present'} ${path})`
          assert.equal(result.file?.ref.version, expected, where)
          assert.equal(result.fileAction.version, expected, where)
          assert.match(result.text, new RegExp(`\\bv${expected}\\b`), where)
          assert.equal(/revised in this reply/.test(result.text), revised, where)

          // The app stores it in the reply.
          assert.ok(result.file)
          store.set(result.file.ref.id, result.file.blob)
          const { id, ...ref } = result.file.ref
          records.push({
            kind: 'presented',
            fileId: id,
            ...ref,
            producedBy: edit ? 'edit_file' : 'present_file',
            messageId: replyId,
            createdAt: (createdAt += 1),
          })
        }
      }

      // One version per reply that saved the path, numbered 1..n, each with that reply's last text.
      for (const artifact of collectWorkspaceArtifacts(records)) {
        const expectedTexts = leftAs.get(artifact.path) ?? []
        assert.deepEqual(
          artifact.versions.map((v) => v.version),
          expectedTexts.map((_, index) => index + 1),
          `seed ${seed}: ${artifact.path}`
        )
        const texts = await Promise.all(
          artifact.versions.map(async (v) => (await store.get(v.fileId)?.text()) ?? null)
        )
        assert.deepEqual(texts, expectedTexts, `seed ${seed}: ${artifact.path}`)
        assert.equal(artifact.latest.fileId, artifact.versions.at(-1)?.fileId)
      }
    }
  })

  it('keeps stored numbers, so older chats that numbered every save still list each one', () => {
    const records: FileRecord[] = [
      presented('old1', 'page.html', { version: 1, messageId: 'old-reply' }),
      presented('old2', 'page.html', { version: 2, messageId: 'old-reply' }),
      // Python files carry no number: a second save in the same reply revises the version.
      presented('py1', 'plot.png', { producedBy: 'python', messageId: 'r1' }),
      presented('py2', 'plot.png', { producedBy: 'python', messageId: 'r1' }),
      presented('py3', 'plot.png', { producedBy: 'python', messageId: 'r2' }),
    ]
    const [page, plot] = collectWorkspaceArtifacts(records)
    assert.deepEqual(
      page?.versions.map((v) => [v.fileId, v.version]),
      [
        ['old1', 1],
        ['old2', 2],
      ]
    )
    assert.deepEqual(
      plot?.versions.map((v) => [v.fileId, v.version]),
      [
        ['py2', 1],
        ['py3', 2],
      ]
    )
  })
})
