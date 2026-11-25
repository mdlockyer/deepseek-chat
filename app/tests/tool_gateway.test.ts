/**
 * Wiring tests for the composed `ToolRegistry` and `createAppRuntime`:
 * verifies tool declarations, summary prepending, effect classification, prompt hygiene (zero
 * em dashes across slices + composition notes), subagent profile invariants, ask_user flows,
 * and live `conversations` + `subagents` integration.
 */
import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import type { ToolRunContext } from '@deepseek-chat/lib-tools'
import { ASK_USER_TOOL_NAME } from '@deepseek-chat/slice-ask-user'
import { POST_TOOL_NAME, WAIT_TOOL_NAME } from '@deepseek-chat/slice-subagents'
import { memoryStore } from '@deepseek-chat/spine/ports'
import { COMPOSITION_PROMPT_NOTES, createAppRuntime } from '../runtime.js'

const makeContext = (overrides: Partial<ToolRunContext> = {}): ToolRunContext => ({
  sessionId: 'wiring',
  replyId: 'r1',
  signal: new AbortController().signal,
  caller: { kind: 'reply' },
  citedUrls: new Map(),
  isActive: () => false,
  onProgress: () => undefined,
  readReplyState: () => undefined,
  writeReplyState: () => undefined,
  ...overrides,
})

describe('app wiring: composed ToolRegistry', () => {
  it('declares every capability tool with summary prepended and classifies effects accurately', () => {
    const runtime = createAppRuntime({
      store: memoryStore({ 'chat-demo:search': 'true', 'chat-demo:python': 'true' }),
    })
    const { tools } = runtime
    const declared = tools.declare({
      questionText: 'what is new?',
      enabledCapabilities: { 'web-research': true, python: true, browser: true },
    })
    const names = declared.map((tool) => tool.name)
    assert.equal(new Set(names).size, names.length, 'no tool is declared twice')
    assert.ok(names.includes('present_file'))
    assert.ok(names.includes('edit_file'))
    assert.ok(names.includes('read_file'))
    assert.ok(names.includes(ASK_USER_TOOL_NAME))
    assert.ok(names.includes('web_search'))
    assert.ok(names.includes('web_scrape'))
    assert.ok(names.includes('research'))
    assert.ok(names.includes('python'))
    assert.ok(names.includes(WAIT_TOOL_NAME))
    assert.ok(names.includes(POST_TOOL_NAME))
    // On web (no desktop browserHost), browser tools are not declared.
    assert.ok(!names.some((name) => name.startsWith('browser_')))

    for (const tool of declared) {
      const props = tool.input_schema.properties as Record<string, { type?: string }> | undefined
      assert.ok(props, `${tool.name} has properties`)
      assert.equal(Object.keys(props)[0], 'summary', `${tool.name} emits summary first`)
      assert.equal(props.summary?.type, 'string')
      assert.ok(
        Array.isArray(tool.input_schema.required) && tool.input_schema.required.includes('summary'),
        `${tool.name} marks summary required`
      )
    }

    assert.equal(tools.effectOf('web_search'), 'read')
    assert.equal(tools.effectOf('web_scrape'), 'read')
    assert.equal(tools.effectOf('research'), 'spawn')
    assert.ok(tools.agentProfile('research'))
    assert.equal(tools.effectOf('read_file'), 'read')
    assert.equal(tools.effectOf('present_file'), 'artifact')
    assert.equal(tools.effectOf('edit_file'), 'artifact')
    assert.equal(tools.effectOf('python'), 'session')
    assert.equal(tools.effectOf(ASK_USER_TOOL_NAME), 'interactive')
    assert.equal(tools.effectOf('browser_click'), 'session')
    assert.equal(tools.effectOf('unknown_tool'), 'session')
    runtime.dispose()
  })

  it('runs ask_user through submit, skip, and abort cleanly', async () => {
    const runtime = createAppRuntime()
    const askUser = runtime.slices.askUser
    assert.ok(askUser)

    const ask1 = runtime.tools.run(
      {
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
      makeContext()
    )
    assert.equal(askUser.submit('wiring', { theme: 'Dark' }), true)
    const res1 = await ask1
    assert.equal(res1.status, 'ok')
    assert.equal(res1.frontStageNote?.status, 'done')
    assert.equal(res1.frontStageNote?.items[0]?.value, 'Dark')
    assert.deepEqual(JSON.parse(res1.content), { status: 'answered', answers: { theme: 'Dark' } })

    const ask2 = runtime.tools.run(
      {
        id: 'ask-2',
        name: ASK_USER_TOOL_NAME,
        input: { questions: [{ id: 'tone', header: 'Tone', question: 'What tone?' }] },
      },
      makeContext()
    )
    assert.equal(askUser.skip('wiring'), true)
    const res2 = await ask2
    assert.equal(res2.status, 'ok')
    assert.equal(res2.frontStageNote?.status, 'skipped')

    const controller = new AbortController()
    const ask3 = runtime.tools.run(
      {
        id: 'ask-3',
        name: ASK_USER_TOOL_NAME,
        input: { questions: [{ id: 'a', header: 'A', question: 'Pick one?' }] },
      },
      makeContext({ signal: controller.signal })
    )
    controller.abort()
    const res3 = await ask3
    assert.equal(res3.status, 'aborted')
    runtime.dispose()
  })

  it('declares Python only when enabled and gates instructions + composition notes to declared tools', () => {
    const runtime = createAppRuntime()
    const { tools } = runtime

    const withPy = tools
      .declare({ questionText: 'hi', enabledCapabilities: { 'web-research': true, python: true } })
      .map((t) => t.name)
    const withoutPy = tools
      .declare({ questionText: 'hi', enabledCapabilities: { 'web-research': true, python: false } })
      .map((t) => t.name)
    assert.ok(withPy.includes('python'))
    assert.ok(!withoutPy.includes('python'))

    const allSections = tools.instructions(new Set(withPy), 'reply')
    assert.ok(allSections.length > 0 && allSections.every((s) => s.trim().length > 0))
    assert.equal(new Set(allSections).size, allSections.length, 'no section repeats')
    assert.deepEqual(tools.instructions(new Set(), 'reply'), [])
    runtime.dispose()
  })

  it('keeps all slice instructions, composition notes, profiles, and tool schemas free of em dashes', () => {
    const runtime = createAppRuntime()
    const { tools } = runtime

    for (const note of COMPOSITION_PROMPT_NOTES) {
      assert.ok(!note.text.includes('—'), 'composition note must not contain em dashes')
    }

    const declared = tools
      .declare({
        questionText: 'check https://example.com',
        enabledCapabilities: { 'web-research': true, python: true },
      })
      .map((t) => t.name)
    const allNames = new Set([...declared, 'browser_navigate'])

    for (const audience of ['reply', 'agent'] as const) {
      const sections = tools.instructions(allNames, audience)
      assert.ok(sections.length > 0)
      for (const section of sections) {
        assert.ok(!section.includes('—'), `${audience} instructions must not contain em dashes`)
      }
    }

    for (const name of declared) {
      const profile = tools.agentProfile(name)
      if (profile) {
        assert.ok(
          !profile.system.includes('—'),
          `${name} profile system must not contain em dashes`
        )
      }
      const described = tools.describe(name, 'reply')
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
    runtime.dispose()
  })

  it('enforces subagent profile wiring invariants across all registered profiles', () => {
    const runtime = createAppRuntime()
    const { tools } = runtime
    const names = tools
      .declare({
        questionText: 'research topic',
        enabledCapabilities: { 'web-research': true, python: true },
      })
      .map((t) => t.name)

    for (const name of names) {
      const profile = tools.agentProfile(name)
      if (profile) {
        assert.equal(tools.effectOf(name), 'spawn', `${name} has effect spawn`)
        for (const toolName of profile.tools) {
          assert.ok(tools.describe(toolName, 'agent'), `${name}: tool ${toolName} exists`)
          assert.equal(
            tools.effectOf(toolName),
            'read',
            `${name}: tool ${toolName} has effect read`
          )
          assert.equal(
            tools.agentProfile(toolName),
            null,
            `${name}: tool ${toolName} is not a subagent`
          )
        }
      }
    }
    runtime.dispose()
  })

  it('answers an unknown tool or Python input without code with an error result', async () => {
    const runtime = createAppRuntime()
    const unknown = await runtime.tools.run(
      { id: 'c1', name: 'no_such_tool', input: {} },
      makeContext()
    )
    assert.equal(unknown.status, 'error')

    const noCode = await runtime.tools.run(
      { id: 'c2', name: 'python', input: { source: 'print(1)' } },
      makeContext()
    )
    assert.equal(noCode.status, 'error')
    runtime.dispose()
  })

  it('integrates real conversations + subagents + web-research through ToolRegistry cleanly', async () => {
    Object.assign(globalThis, {
      document: { visibilityState: 'hidden' },
      requestAnimationFrame: (cb: () => void) => setTimeout(cb, 0),
      cancelAnimationFrame: (id: ReturnType<typeof setTimeout>) => clearTimeout(id),
    })

    let leadRound = 0
    let childRound = 0
    const sse = (events: unknown[]) =>
      new Response(
        events
          .map((e) => `event: ${(e as { type: string }).type}\ndata: ${JSON.stringify(e)}\n\n`)
          .join(''),
        { headers: { 'Content-Type': 'text/event-stream' } }
      )
    const usage = {
      input_tokens: 1,
      cache_creation_input_tokens: 0,
      cache_read_input_tokens: 0,
      output_tokens: 1,
    }
    const replyEvents = (
      blocks: Array<
        { kind: 'text'; text: string } | { kind: 'call'; id: string; name: string; input: unknown }
      >,
      stopReason: 'end_turn' | 'tool_use'
    ) => [
      { type: 'message_start', message: { id: 'm', role: 'assistant', content: [], usage } },
      ...blocks.flatMap((b, index) => [
        {
          type: 'content_block_start',
          index,
          content_block:
            b.kind === 'text'
              ? { type: 'text', text: '' }
              : { type: 'tool_use', id: b.id, name: b.name, input: {} },
        },
        {
          type: 'content_block_delta',
          index,
          delta:
            b.kind === 'text'
              ? { type: 'text_delta', text: b.text }
              : { type: 'input_json_delta', partial_json: JSON.stringify(b.input) },
        },
        { type: 'content_block_stop', index },
      ]),
      { type: 'message_delta', delta: { stop_reason: stopReason }, usage },
      { type: 'message_stop' },
    ]

    const runtime = createAppRuntime({
      store: memoryStore({
        'chat-demo:api-key': 'sk-test',
        'chat-demo:search': 'true',
      }),
      autoTitle: false,
      fetch: async (url, init) => {
        if (!url.endsWith('/messages')) {
          throw new Error(`unexpected URL: ${url}`)
        }
        const body = JSON.parse(String(init.body)) as {
          tools?: { name: string }[]
        }
        const isChild = body.tools?.some((t) => t.name === 'finish_research') ?? false
        if (isChild) {
          childRound += 1
          await new Promise((resolve) => setTimeout(resolve, 25))
          return sse(
            replyEvents(
              [
                {
                  kind: 'call',
                  id: `child-finish-${childRound}`,
                  name: 'finish_research',
                  input: {
                    summary: 'Finishing child report',
                    answer: 'Subagent found SSA works cleanly.',
                    sources: [],
                  },
                },
              ],
              'tool_use'
            )
          )
        }
        leadRound += 1
        if (leadRound === 1) {
          return sse(
            replyEvents(
              [
                {
                  kind: 'call',
                  id: 'lead-spawn-1',
                  name: 'research',
                  input: {
                    summary: 'Researching SSA',
                    objective: 'How does SSA work?',
                    boundaries: 'Architecture only',
                  },
                },
              ],
              'tool_use'
            )
          )
        }
        if (leadRound === 2) {
          // Lead finishes without calling wait -> subagents' turnHook injects auto-wait!
          return sse(replyEvents([{ kind: 'text', text: 'Interim.' }], 'end_turn'))
        }
        return sse(
          replyEvents([{ kind: 'text', text: 'Final answer using subagent findings.' }], 'end_turn')
        )
      },
    })

    await runtime.slices.conversations.commands.init()
    runtime.slices.conversations.commands.setDraft(null, 'Research SSA')
    assert.equal(runtime.slices.conversations.commands.send(null), true)
    await runtime.slices.conversations.commands.whenIdle()

    const sessionId = runtime.slices.conversations.getState().activeId
    assert.ok(sessionId)
    const last = runtime.slices.conversations.getChatMessages(sessionId).at(-1)
    assert.equal(last?.role, 'assistant')
    if (last?.role === 'assistant') {
      assert.equal(last.status, 'done')
      assert.equal(childRound, 1, 'child subagent executed once')
      assert.ok(leadRound >= 3, 'subagents turnHook injected auto-wait before finishing')
      const subState = last.capabilityState?.subagents as {
        agents?: { state: { status: string } }[]
      }
      assert.equal(subState?.agents?.length, 1)
      assert.equal(subState?.agents?.[0]?.state.status, 'finished')
    }
    runtime.dispose()
  })
})
