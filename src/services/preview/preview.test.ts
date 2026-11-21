import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import type { Message } from '../chat/types.js'
import {
  acquireSidePanelOverlayLock,
  closeActiveRightPanelKind,
  getActiveRightPanel,
  openRightPanel,
  registerOverlayLockListener,
  setActiveSidePanelSession,
  useSidePanelStore,
} from '../sidePanel/state.js'
import {
  classifyPreviewKind,
  getCodeLanguage,
  inferMimeType,
  parseDelimitedText,
  supportsPreviewToggle,
} from './fileKinds.js'
import {
  clearAllSessionPreviews,
  closePreviewPanel,
  getSessionPreview,
  openPreviewFile,
  openPreviewPanel,
  revealPresentedFile,
  selectPreviewFile,
  selectPreviewVersion,
  usePreviewStore,
} from './state.js'
import {
  EDIT_FILE_TOOL_NAME,
  PRESENT_FILE_TOOL_NAME,
  READ_FILE_TOOL_NAME,
  applyTextEdits,
  runPreviewTool,
} from './tools.js'
import {
  collectWorkspaceArtifacts,
  findWorkspaceFile,
  makeArtifactKey,
  normalizeWorkspacePath,
} from './workspace.js'

const resetPanelStores = (activeSessionId: string | null = 's1') => {
  clearAllSessionPreviews()
  useSidePanelStore.setState({
    activeSessionId,
    activePanels: {},
    panelAnimating: false,
    panelResizing: false,
    overlayLocks: 0,
    stageSize: null,
  })
}

describe('preview file classification and delimited parsing', () => {
  it('infers MIME types from extensions while preserving explicit non-generic types', () => {
    assert.equal(inferMimeType('app.html'), 'text/html')
    assert.equal(inferMimeType('diagram.svg'), 'image/svg+xml')
    assert.equal(inferMimeType('data.csv'), 'text/csv')
    assert.equal(inferMimeType('notes.md', 'application/octet-stream'), 'text/markdown')
    assert.equal(inferMimeType('custom.txt', 'text/csv; charset=utf-8'), 'text/csv')
    assert.equal(inferMimeType('unknown.bin'), 'application/octet-stream')
  })

  it('classifies preview kinds and toggle availability accurately', () => {
    assert.equal(classifyPreviewKind('page.html', 'text/html'), 'html')
    assert.equal(classifyPreviewKind('chart.svg', 'image/svg+xml'), 'svg')
    assert.equal(classifyPreviewKind('photo.png', 'image/png'), 'image')
    assert.equal(classifyPreviewKind('doc.md', 'text/markdown'), 'markdown')
    assert.equal(classifyPreviewKind('flow.mmd', 'text/plain'), 'mermaid')
    assert.equal(classifyPreviewKind('metrics.tsv', 'text/tab-separated-values'), 'table')
    assert.equal(classifyPreviewKind('deck.pdf', 'application/pdf'), 'pdf')
    assert.equal(classifyPreviewKind('Dockerfile', ''), 'code')
    assert.equal(classifyPreviewKind('archive.zip', 'application/zip'), 'binary')

    assert.equal(supportsPreviewToggle('html'), true)
    assert.equal(supportsPreviewToggle('svg'), true)
    assert.equal(supportsPreviewToggle('markdown'), true)
    assert.equal(supportsPreviewToggle('table'), true)
    assert.equal(supportsPreviewToggle('code'), false)
    assert.equal(supportsPreviewKindToggleCheck(), true)
  })

  it('maps extensions and MIME types to Prism language names', () => {
    assert.equal(getCodeLanguage('widget.tsx', ''), 'tsx')
    assert.equal(getCodeLanguage('script.py', ''), 'python')
    assert.equal(getCodeLanguage('data', 'application/json'), 'json')
    assert.equal(getCodeLanguage('notes.unknown', 'text/plain'), 'text')
  })

  it('parses RFC-4180 CSV with quotes, escaped quotes, embedded newlines, CRLF, and truncation', () => {
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
  })
})

const supportsPreviewKindToggleCheck = () =>
  !supportsPreviewToggle('image') &&
  !supportsPreviewToggle('pdf') &&
  !supportsPreviewToggle('binary')

describe('workspace path normalization, artifact versioning, and resolution', () => {
  it('sanitizes workspace paths against leading slashes and parent traversal', () => {
    assert.equal(normalizeWorkspacePath('/./charts/../reports//q4.md'), 'charts/reports/q4.md')
    assert.equal(normalizeWorkspacePath('..\\app.html'), 'app.html')
    assert.equal(normalizeWorkspacePath('   '), '')
  })

  it('collects ordered artifact versions across turns and resolves uploads only when requested', () => {
    const messages: Message[] = [
      {
        id: 'u1',
        role: 'user',
        content: 'check notes.txt',
        files: [
          {
            id: 'up-1',
            serverId: 'srv-1',
            name: 'notes.txt',
            size: 12,
            isImage: false,
            mimeType: 'text/plain',
          },
        ],
        createdAt: 1_000,
      },
      {
        id: 'a1',
        role: 'assistant',
        createdAt: 2_000,
        model: 'deepseek-flash',
        prefix: false,
        status: 'done',
        blocks: [
          { type: 'tool_use', id: 'c1', name: 'present_file', input: { path: 'app.html' } },
          {
            type: 'tool_result',
            tool_use_id: 'c1',
            content: 'ok',
            status: 'ok',
            files: [
              {
                id: 'f1',
                name: 'app.html',
                path: 'app.html',
                size: 100,
                mimeType: 'text/html',
                version: 1,
                source: 'model',
              },
            ],
          },
          { type: 'tool_use', id: 'c2', name: 'python', input: { code: '...' } },
          {
            type: 'tool_result',
            tool_use_id: 'c2',
            content: 'ok',
            status: 'ok',
            files: [{ id: 'py1', name: 'out.csv', size: 40, mimeType: 'text/csv' }],
          },
        ],
      },
      {
        id: 'a2',
        role: 'assistant',
        createdAt: 3_000,
        model: 'deepseek-flash',
        prefix: false,
        status: 'done',
        blocks: [
          { type: 'tool_use', id: 'c3', name: 'edit_file', input: { path: 'app.html' } },
          {
            type: 'tool_result',
            tool_use_id: 'c3',
            content: 'ok',
            status: 'ok',
            files: [
              {
                id: 'f2',
                name: 'app.html',
                path: 'app.html',
                title: 'Interactive App',
                size: 120,
                mimeType: 'text/html',
                version: 2,
                source: 'model',
              },
            ],
          },
        ],
      },
    ]

    const artifacts = collectWorkspaceArtifacts(messages)
    assert.equal(artifacts.length, 2)
    assert.equal(artifacts[0]?.versions.length, 2)
    assert.equal(artifacts[0]?.latest.fileId, 'f2')
    assert.equal(artifacts[0]?.latest.version, 2)
    assert.equal(artifacts[0]?.title, 'Interactive App')
    assert.equal(artifacts[1]?.source, 'python')
    assert.equal(artifacts[1]?.latest.fileId, 'py1')

    assert.equal(findWorkspaceFile(messages, 'notes.txt', { includeUploads: false }), null)
    assert.equal(findWorkspaceFile(messages, 'notes.txt', { includeUploads: true })?.fileId, 'up-1')
    assert.equal(findWorkspaceFile(messages, 'APP.HTML')?.fileId, 'f2')
  })
})

describe('preview tool execution (present_file, edit_file, read_file)', () => {
  it('validates sequential text edits and rejects missing or ambiguous matches', () => {
    const edited = applyTextEdits(
      'const a = 1\nconst b = 2\n',
      [
        { old_text: 'const a = 1', new_text: 'const a = 10' },
        { old_text: 'a = 10\nconst b = 2', new_text: 'a = 10\nconst b = 20' },
      ],
      'test.js'
    )
    assert.equal(edited, 'const a = 10\nconst b = 20\n')

    assert.throws(
      () => applyTextEdits('hello', [{ old_text: 'missing', new_text: 'x' }], 'test.js'),
      /old_text not found/
    )
    assert.throws(
      () => applyTextEdits('foo\nfoo', [{ old_text: 'foo', new_text: 'bar' }], 'test.js'),
      /matched 2 places/
    )
  })

  it('creates versioned blobs on present_file and edit_file without mutating prior versions', async () => {
    const store = new Map<string, Blob>()
    const loadFile = async (id: string) => store.get(id)
    const messages: Message[] = []

    const res1 = await runPreviewTool(
      PRESENT_FILE_TOOL_NAME,
      { path: 'charts/sales.html', content: '<h1>v1</h1>', title: 'Sales Chart' },
      { messages, loadFile }
    )
    assert.equal(res1.status, 'ok')
    assert.ok(res1.file)
    assert.equal(res1.file.ref.version, 1)
    assert.equal(res1.file.ref.path, 'charts/sales.html')
    assert.equal(res1.file.ref.name, 'sales.html')
    store.set(res1.file.ref.id, res1.file.blob)

    messages.push({
      id: 'a1',
      role: 'assistant',
      createdAt: 1_000,
      model: 'deepseek-flash',
      prefix: false,
      status: 'done',
      blocks: [
        { type: 'tool_use', id: 't1', name: PRESENT_FILE_TOOL_NAME, input: {} },
        {
          type: 'tool_result',
          tool_use_id: 't1',
          content: res1.text,
          status: 'ok',
          files: [res1.file.ref],
        },
      ],
    })

    const res2 = await runPreviewTool(
      EDIT_FILE_TOOL_NAME,
      {
        path: 'sales.html',
        edits: [{ old_text: '<h1>v1</h1>', new_text: '<h1>v2</h1>' }],
      },
      { messages, loadFile }
    )
    assert.equal(res2.status, 'ok')
    assert.ok(res2.file)
    assert.equal(res2.file.ref.version, 2)
    assert.notEqual(res2.file.ref.id, res1.file.ref.id)
    store.set(res2.file.ref.id, res2.file.blob)

    // v1 blob remains untouched
    assert.equal(await store.get(res1.file.ref.id)?.text(), '<h1>v1</h1>')
    assert.equal(await store.get(res2.file.ref.id)?.text(), '<h1>v2</h1>')

    messages.push({
      id: 'a2',
      role: 'assistant',
      createdAt: 2_000,
      model: 'deepseek-flash',
      prefix: false,
      status: 'done',
      blocks: [
        { type: 'tool_use', id: 't2', name: EDIT_FILE_TOOL_NAME, input: {} },
        {
          type: 'tool_result',
          tool_use_id: 't2',
          content: res2.text,
          status: 'ok',
          files: [res2.file.ref],
        },
      ],
    })

    const readRes = await runPreviewTool(
      READ_FILE_TOOL_NAME,
      { path: 'charts/sales.html' },
      { messages, loadFile }
    )
    assert.equal(readRes.status, 'ok')
    assert.match(readRes.text, /\(v2, text\/html/)
    assert.match(readRes.text, /<h1>v2<\/h1>/)
  })

  it('truncates oversized read_file output and rejects binary files cleanly', async () => {
    const bigText = 'x'.repeat(45_000)
    const store = new Map<string, Blob>([
      ['big', new Blob([bigText], { type: 'text/plain' })],
      ['img', new Blob([new Uint8Array([1, 2, 3])], { type: 'image/png' })],
    ])
    const messages: Message[] = [
      {
        id: 'u1',
        role: 'user',
        content: 'files',
        files: [
          {
            id: 'big',
            serverId: null,
            name: 'big.txt',
            size: 45_000,
            isImage: false,
            mimeType: 'text/plain',
          },
          {
            id: 'img',
            serverId: null,
            name: 'pic.png',
            size: 3,
            isImage: true,
            mimeType: 'image/png',
          },
        ],
        createdAt: 1_000,
      },
    ]

    const readBig = await runPreviewTool(
      READ_FILE_TOOL_NAME,
      { path: 'big.txt' },
      { messages, loadFile: async (id) => store.get(id) }
    )
    assert.equal(readBig.status, 'ok')
    assert.match(readBig.text, /\[Truncated after 40,000 of 45,000 characters\]/)

    const readImg = await runPreviewTool(
      READ_FILE_TOOL_NAME,
      { path: 'pic.png' },
      { messages, loadFile: async (id) => store.get(id) }
    )
    assert.equal(readImg.status, 'error')
    assert.match(readImg.text, /not a UTF-8 text file/)
  })
})

describe('right-rail coordination and preview tab state', () => {
  it('prevents closeActiveRightPanelKind("search") from closing an open preview or browser panel', () => {
    resetPanelStores('s1')
    openRightPanel('s1', 'preview')
    assert.equal(getActiveRightPanel('s1'), 'preview')

    // Message sends trigger closeSearchPanel() -> closeActiveRightPanelKind('search')
    closeActiveRightPanelKind('search')
    assert.equal(getActiveRightPanel('s1'), 'preview')

    openRightPanel('s1', 'search')
    assert.equal(getActiveRightPanel('s1'), 'search')
    closeActiveRightPanelKind('search')
    assert.equal(getActiveRightPanel('s1'), null)
  })

  it('tracks active file, version pins, background session reveal, and switching without tabs', () => {
    resetPanelStores('s1')
    const keyA = makeArtifactKey('a.html')
    const keyB = makeArtifactKey('b.md')

    // Opening historical version v1 pins it; revealing a new version clears the pin
    openPreviewFile('s1', keyA, 'f1', false)
    assert.equal(getActiveRightPanel('s1'), 'preview')
    assert.equal(getSessionPreview(usePreviewStore.getState(), 's1').activeKey, keyA)
    assert.equal(
      getSessionPreview(usePreviewStore.getState(), 's1').selectedFileIdByKey[keyA],
      'f1'
    )

    revealPresentedFile('s1', keyA, { openPanel: true })
    assert.equal(
      getSessionPreview(usePreviewStore.getState(), 's1').selectedFileIdByKey[keyA],
      undefined
    )

    // Background session s2 presents a file while user is viewing s1 -> activeKey updates without stealing s1 panel
    setActiveSidePanelSession('s1')
    revealPresentedFile('s2', keyB, { openPanel: false })
    assert.equal(getActiveRightPanel('s1'), 'preview')
    assert.equal(getActiveRightPanel('s2'), null)
    assert.equal(getSessionPreview(usePreviewStore.getState(), 's2').activeKey, keyB)

    // Selecting version, switching active file, and closing panel preserves selection
    selectPreviewVersion('s1', keyA, 'f1')
    assert.equal(
      getSessionPreview(usePreviewStore.getState(), 's1').selectedFileIdByKey[keyA],
      'f1'
    )

    selectPreviewFile('s1', keyB)
    assert.equal(getSessionPreview(usePreviewStore.getState(), 's1').activeKey, keyB)

    closePreviewPanel('s1')
    assert.equal(getActiveRightPanel('s1'), null)
    assert.equal(getSessionPreview(usePreviewStore.getState(), 's1').activeKey, keyB)

    // Reopening via openPreviewPanel falls back to latest artifact if activeKey is not in valid branch
    openPreviewPanel('s1', [keyA])
    assert.equal(getActiveRightPanel('s1'), 'preview')
    assert.equal(getSessionPreview(usePreviewStore.getState(), 's1').activeKey, keyA)
  })

  it('fires shared overlay lock listeners only on 0->1 and 1->0 transitions', () => {
    resetPanelStores('s1')
    const events: boolean[] = []
    const unsub = registerOverlayLockListener((locked) => events.push(locked))

    const release1 = acquireSidePanelOverlayLock()
    const release2 = acquireSidePanelOverlayLock()
    assert.deepEqual(events, [true])

    release1()
    assert.deepEqual(events, [true])
    release1() // idempotent release
    assert.deepEqual(events, [true])

    release2()
    assert.deepEqual(events, [true, false])
    unsub()
  })
})
