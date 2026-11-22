/**
 * Wiring: the app's tool gateway (conversations' ToolGateway port) over the real slices, as the web
 * build composes them (no desktop host, so no built-in browser).
 */
import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import type { Message, ToolRunContext } from '@deepseek-chat/slice-conversations'
import { collectPythonUploads, toolGateway } from '../toolGateway.js'

const declaredNames = (toggles: { search: boolean; python: boolean }) =>
  toolGateway
    .declare({ ...toggles, browser: true, questionText: 'what is new?' })
    .flatMap((tool) => ('name' in tool ? [tool.name] : []))

const context = (): ToolRunContext => ({
  sessionId: 'wiring',
  signal: new AbortController().signal,
  replyBlocks: [],
  messages: [],
  isActive: () => false,
  onPhase: () => undefined,
  saveFiles: async () => undefined,
  loadFile: async () => undefined,
})

describe('app wiring: tool gateway', () => {
  it('classifies every tool it declares, each owner’s tools under that owner’s kinds', () => {
    const names = declaredNames({ search: true, python: true })
    assert.equal(new Set(names).size, names.length, 'no tool is declared twice')
    const kinds = names.map((name) => toolGateway.kindOf(name))
    // Unclassified tools would show as code (conversations SPEC invariant 4).
    assert.ok(!kinds.includes(null), `unclassified: ${names.filter((_, i) => kinds[i] === null)}`)
    // The file, web and Python owners each contribute their kinds; one tool per kind here.
    assert.deepEqual(
      [...kinds].sort(),
      ['edit_file', 'present_file', 'python', 'read_file', 'web_scrape', 'web_search'].sort()
    )
  })

  it('declares Python only when its toggle is on, and never a browser on the web build', () => {
    const kindsOf = (python: boolean) =>
      declaredNames({ search: true, python }).map((name) => toolGateway.kindOf(name))
    assert.ok(kindsOf(true).includes('python'))
    assert.ok(!kindsOf(false).includes('python'))
    assert.ok(!kindsOf(true).includes('browser'))
  })

  it('gives instructions for the declared tools only, and none for no tools', () => {
    const names = new Set(declaredNames({ search: true, python: true }))
    const all = toolGateway.instructions(names)
    assert.ok(all.length > 0 && all.every((section) => section.trim().length > 0))
    assert.equal(new Set(all).size, all.length, 'no section repeats')
    assert.deepEqual(toolGateway.instructions(new Set()), [])
  })

  it(
    'answers an unknown tool, or Python input without code, with an error result',
    { timeout: 5_000 },
    async () => {
      assert.equal(toolGateway.kindOf('no_such_tool'), null)
      const unknown = await toolGateway.run(
        { type: 'tool_use', id: 'c1', name: 'no_such_tool', input: {} },
        context()
      )
      assert.equal(unknown.status, 'error')
      const pythonName = declaredNames({ search: false, python: true }).find(
        (name) => toolGateway.kindOf(name) === 'python'
      )
      assert.ok(pythonName)
      const noCode = await toolGateway.run(
        { type: 'tool_use', id: 'c2', name: pythonName, input: { source: 'print(1)' } },
        context()
      )
      assert.equal(noCode.status, 'error')
    }
  )

  it('mounts user uploads and the latest model-presented files for Python, excluding Python outputs', () => {
    const messages: Message[] = [
      {
        id: 'u1',
        role: 'user',
        content: 'analyze',
        createdAt: 1,
        files: [
          {
            id: 'up-1',
            serverId: null,
            name: 'raw.csv',
            size: 10,
            isImage: false,
            mimeType: 'text/csv',
          },
        ],
      },
      {
        id: 'a1',
        role: 'assistant',
        createdAt: 2,
        model: 'deepseek-flash',
        thinking: false,
        search: false,
        python: true,
        browser: false,
        prefix: false,
        status: 'done',
        blocks: [
          { type: 'tool_use', id: 't1', name: 'present_file', input: {} },
          {
            type: 'tool_result',
            tool_use_id: 't1',
            content: 'ok',
            status: 'ok',
            files: [
              {
                id: 'p1',
                name: 'report.md',
                path: 'report.md',
                size: 5,
                mimeType: 'text/markdown',
                version: 1,
                source: 'model',
              },
            ],
          },
          { type: 'tool_use', id: 't2', name: 'python', input: {} },
          {
            type: 'tool_result',
            tool_use_id: 't2',
            content: 'ok',
            status: 'ok',
            files: [
              {
                id: 'py1',
                name: 'chart.png',
                path: 'chart.png',
                size: 20,
                mimeType: 'image/png',
                source: 'python',
              },
            ],
          },
        ],
      },
      {
        id: 'a2',
        role: 'assistant',
        createdAt: 3,
        model: 'deepseek-flash',
        thinking: false,
        search: false,
        python: true,
        browser: false,
        prefix: false,
        status: 'done',
        blocks: [
          { type: 'tool_use', id: 't3', name: 'edit_file', input: {} },
          {
            type: 'tool_result',
            tool_use_id: 't3',
            content: 'ok',
            status: 'ok',
            files: [
              {
                id: 'p2',
                name: 'report.md',
                path: 'report.md',
                size: 8,
                mimeType: 'text/markdown',
                version: 2,
                source: 'model',
              },
            ],
          },
        ],
      },
    ]

    const uploads = collectPythonUploads(messages, async () => undefined)
    assert.deepEqual(
      uploads.map((u) => [u.id, u.name]),
      [
        ['up-1', 'raw.csv'],
        ['p2', 'report.md'],
      ]
    )
  })
})
