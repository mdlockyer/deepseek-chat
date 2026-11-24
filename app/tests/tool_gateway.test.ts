/**
 * Wiring: the app's tool gateway (conversations' ToolGateway port) over the real slices, as the web
 * build composes them (no desktop host, so no built-in browser).
 */
import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import {
  ASK_USER_TOOL_NAME,
  skipAskUser,
  submitAskUser,
  type Message,
  type ToolRunContext,
} from '@deepseek-chat/slice-conversations'
import { collectPythonUploads, toolGateway } from '../toolGateway.js'

const declaredNames = (toggles: { search: boolean; python: boolean }) =>
  toolGateway
    .declare({ ...toggles, browser: true, questionText: 'what is new?' })
    .flatMap((tool) => ('name' in tool ? [tool.name] : []))

const context = (): ToolRunContext => ({
  sessionId: 'wiring',
  signal: new AbortController().signal,
  caller: { kind: 'reply' },
  replyBlocks: [],
  citedUrls: new Map(),
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
      [
        'ask_user',
        'edit_file',
        'present_file',
        'python',
        'read_file',
        'subagent',
        'web_scrape',
        'web_search',
      ].sort()
    )
    // Effect classification matches each tool's side-effect class.
    assert.equal(toolGateway.effectOf('web_search'), 'read')
    assert.equal(toolGateway.effectOf('web_scrape'), 'read')
    assert.equal(toolGateway.effectOf('research'), 'spawn')
    assert.ok(toolGateway.agentProfile('research'))
    assert.equal(toolGateway.effectOf('read_file'), 'read')
    assert.equal(toolGateway.effectOf('present_file'), 'artifact')
    assert.equal(toolGateway.effectOf('edit_file'), 'artifact')
    assert.equal(toolGateway.effectOf('python'), 'session')
    assert.equal(toolGateway.effectOf('ask_user'), 'interactive')
    assert.equal(toolGateway.effectOf('browser_click'), 'session')
    assert.equal(toolGateway.effectOf('unknown_tool'), 'session')
  })

  it('runs ask_user through submit, skip, and abort cleanly', async () => {
    // Submit path
    const ask1 = toolGateway.run(
      {
        type: 'tool_use',
        id: 'ask-1',
        name: ASK_USER_TOOL_NAME,
        input: {
          questions: [
            {
              id: 'theme',
              header: 'Theme',
              question: 'Which visual theme do you want?',
              options: [{ label: 'Dark', recommended: true }, { label: 'Light' }],
            },
          ],
        },
      },
      context()
    )
    assert.equal(submitAskUser('wiring', { theme: 'Dark' }), true)
    const res1 = await ask1
    assert.equal(res1.status, 'ok')
    assert.equal(res1.askAction?.status, 'answered')
    assert.equal(res1.askAction?.items[0]?.answer, 'Dark')
    assert.deepEqual(JSON.parse(res1.content), { status: 'answered', answers: { theme: 'Dark' } })

    // Skip path
    const ask2 = toolGateway.run(
      {
        type: 'tool_use',
        id: 'ask-2',
        name: ASK_USER_TOOL_NAME,
        input: {
          questions: [{ id: 'tone', header: 'Tone', question: 'What tone?' }],
        },
      },
      context()
    )
    assert.equal(skipAskUser('wiring'), true)
    const res2 = await ask2
    assert.equal(res2.status, 'ok')
    assert.equal(res2.askAction?.status, 'skipped')

    // Abort path
    const controller = new AbortController()
    const ask3 = toolGateway.run(
      {
        type: 'tool_use',
        id: 'ask-3',
        name: ASK_USER_TOOL_NAME,
        input: {
          questions: [{ id: 'a', header: 'A', question: 'Pick one?' }],
        },
      },
      { ...context(), signal: controller.signal }
    )
    controller.abort()
    const res3 = await ask3
    assert.equal(res3.status, 'aborted')
  })

  it('prepends a required summary parameter as the first property on every declared client tool', () => {
    const tools = toolGateway.declare({
      search: true,
      python: true,
      browser: true,
      questionText: 'check https://example.com',
    })
    assert.ok(tools.length > 0)
    for (const tool of tools) {
      if (!('input_schema' in tool)) {
        continue
      }
      const props = tool.input_schema.properties as Record<string, { type?: string }> | undefined
      assert.ok(props, `${tool.name} has properties`)
      assert.equal(Object.keys(props)[0], 'summary', `${tool.name} emits summary first`)
      assert.equal(props.summary?.type, 'string')
      assert.ok(
        Array.isArray(tool.input_schema.required) && tool.input_schema.required.includes('summary'),
        `${tool.name} marks summary required`
      )
    }
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
    const all = toolGateway.instructions(names, 'reply')
    assert.ok(all.length > 0 && all.every((section) => section.trim().length > 0))
    assert.equal(new Set(all).size, all.length, 'no section repeats')
    assert.deepEqual(toolGateway.instructions(new Set(), 'reply'), [])
  })

  it('keeps slice instructions, profiles, and tool schemas free of em-dash priming', () => {
    const declared = declaredNames({ search: true, python: true })
    const instructionNames = new Set([...declared, 'browser_navigate'])
    for (const audience of ['reply', 'agent'] as const) {
      const sections = toolGateway.instructions(instructionNames, audience)
      assert.ok(sections.length > 0)
      for (const section of sections) {
        assert.ok(!section.includes('—'), `${audience} instructions must not contain em dashes`)
      }
    }
    for (const name of declared) {
      const profile = toolGateway.agentProfile(name)
      if (profile) {
        assert.ok(
          !profile.system.includes('—'),
          `${name} profile system must not contain em dashes`
        )
      }
      const described = toolGateway.describe(name, 'reply')
      assert.ok(described, `${name} is describable`)
      assert.ok(
        !described.description.includes('—'),
        `${name} description must not contain em dashes`
      )
      const props = described.input_schema.properties as
        | Record<string, { description?: string }>
        | undefined
      assert.ok(
        !props?.summary?.description?.includes('—'),
        `${name} summary schema must not contain em dashes`
      )
    }
  })

  it('enforces subagent profile wiring invariants across all registered profiles', () => {
    const names = declaredNames({ search: true, python: true })
    for (const name of names) {
      const profile = toolGateway.agentProfile(name)
      const isSubagent = toolGateway.kindOf(name) === 'subagent'
      assert.equal(
        profile !== null,
        isSubagent,
        `${name}: agentProfile matches kindOf === subagent`
      )
      if (profile) {
        assert.equal(toolGateway.effectOf(name), 'spawn', `${name} has effect spawn`)
        for (const toolName of profile.tools) {
          assert.ok(toolGateway.describe(toolName, 'agent'), `${name}: tool ${toolName} exists`)
          assert.equal(
            toolGateway.effectOf(toolName),
            'read',
            `${name}: tool ${toolName} has effect read`
          )
          assert.notEqual(
            toolGateway.kindOf(toolName),
            'subagent',
            `${name}: tool ${toolName} is not a subagent`
          )
        }
      }
    }
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
