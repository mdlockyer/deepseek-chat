import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { createDeepSeekProvider } from '@deepseek-chat/lib-agent'
import {
  createToolRegistry,
  type AgentProfileSpec,
  type ToolCapability,
  type ToolRunContext,
} from '@deepseek-chat/lib-tools'
import { EventLog } from '@deepseek-chat/spine/runtime'
import {
  POST_TOOL_NAME,
  WAIT_TOOL_NAME,
  assignChildCitations,
  createSubagentsSlice,
  isSubagentsReplyState,
  settleHydratedSubagentsState,
} from '@deepseek-chat/slice-subagents'

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

const toolCallStream = (calls: readonly { id: string; name: string; input: unknown }[]) =>
  sse([
    { type: 'message_start', message: { id: 'm1', role: 'assistant', content: [], usage } },
    ...calls.flatMap((c, i) => [
      {
        type: 'content_block_start',
        index: i,
        content_block: { type: 'tool_use', id: c.id, name: c.name, input: {} },
      },
      {
        type: 'content_block_delta',
        index: i,
        delta: { type: 'input_json_delta', partial_json: JSON.stringify(c.input) },
      },
      { type: 'content_block_stop', index: i },
    ]),
    { type: 'message_delta', delta: { stop_reason: 'tool_use' }, usage },
    { type: 'message_stop' },
  ])

describe('slice-subagents: spawn, read-only guard, board, wait, citations, and turnHooks', () => {
  it('spawns a child from an external AgentProfileSpec, enforces read-only allow-list, delivers numbered citations, and isolates instances', async () => {
    let childTurn = 0
    const childRequests: unknown[] = []
    const forbiddenCalls: string[] = []

    const profile: AgentProfileSpec = {
      thinking: false,
      label: 'Test Researcher',
      system: 'Research carefully.',
      tools: ['read_item', 'write_item'],
      context: 'clean',
      finish: {
        name: 'finish_task',
        description: 'Return answer.',
        input_schema: {
          type: 'object',
          required: ['answer', 'sources'],
          properties: { answer: { type: 'string' }, sources: { type: 'array' } },
        },
      },
      limits: { maxRounds: 4, maxToolCalls: 6 },
      task: (input) => {
        const topic =
          input && typeof (input as { topic?: unknown }).topic === 'string'
            ? (input as { topic: string }).topic
            : ''
        return topic
          ? { kind: 'ok', message: `Investigate ${topic}` }
          : { kind: 'invalid', reason: 'missing topic' }
      },
      complete: async (output) => {
        const rec = output as {
          answer: string
          sources: { n: number; url: string; title: string }[]
        }
        return {
          content: rec.answer,
          sources: rec.sources.map((s) => ({ ...s, verification: 'verified' as const })),
        }
      },
    }

    const providerCap: ToolCapability = {
      id: 'provider',
      declareTools: () => [
        {
          name: 'spawn_researcher',
          description: 'Spawn researcher',
          input_schema: {
            type: 'object',
            properties: { topic: { type: 'string' } },
            required: ['topic'],
          },
        },
        {
          name: 'read_item',
          description: 'Read item',
          input_schema: {
            type: 'object',
            properties: { id: { type: 'string' } },
            required: ['id'],
          },
        },
        {
          name: 'write_item',
          description: 'Write item (disallowed for child)',
          input_schema: { type: 'object', properties: {} },
        },
      ],
      instructions: () => null,
      handles: (name) => name === 'read_item' || name === 'write_item',
      effectOf: (name) =>
        name === 'read_item' ? 'read' : name === 'spawn_researcher' ? 'spawn' : 'session',
      agentProfile: (name) => (name === 'spawn_researcher' ? profile : null),
      run: async (call) => {
        if (call.name === 'write_item') {
          forbiddenCalls.push(call.name)
        }
        return { status: 'ok', content: `item:${JSON.stringify(call.input)}` }
      },
    }

    let registryRef!: ReturnType<typeof createToolRegistry>
    const log = new EventLog()
    const subagents = createSubagentsSlice({
      log,
      provider: createDeepSeekProvider({
        apiOrigin: 'https://api.test',
        getApiKey: () => 'sk-test',
        fetch: async (_url, init) => {
          childRequests.push(JSON.parse(String(init.body)))
          childTurn += 1
          if (childTurn === 1) {
            return toolCallStream([
              { id: 'c1', name: 'read_item', input: { id: 'alpha' } },
              { id: 'c2', name: 'write_item', input: {} },
              {
                id: 'c3',
                name: POST_TOOL_NAME,
                input: { kind: 'finding', text: 'Found key metric', url: 'https://example.com/a' },
              },
            ])
          }
          return toolCallStream([
            {
              id: 'c4',
              name: 'finish_task',
              input: {
                answer: 'Alpha result [1].',
                sources: [{ n: 1, url: 'https://example.com/a', title: 'Alpha Doc' }],
              },
            },
          ])
        },
      }),
      getToolHost: () => registryRef,
    })

    registryRef = createToolRegistry([providerCap, subagents.capability])

    // Subagents automatically declares wait & post when a spawn profile is present
    const declared = registryRef.declare({ questionText: '', enabledCapabilities: {} })
    assert.ok(declared.some((t) => t.name === WAIT_TOOL_NAME))
    assert.ok(declared.some((t) => t.name === POST_TOOL_NAME))

    let persistedState: unknown
    const makeCtx = (
      citedUrls = new Map<string, number>([['https://prior.example', 1]])
    ): ToolRunContext => ({
      sessionId: 's1',
      replyId: 'r1',
      signal: new AbortController().signal,
      caller: { kind: 'reply' },
      citedUrls,
      environmentContext: '<environment_context>\nDate: 2026-11-25\n</environment_context>',
      isActive: () => true,
      onProgress: () => undefined,
      readReplyState: () => persistedState as never,
      writeReplyState: (next) => {
        persistedState = next
      },
    })

    const spawned = await registryRef.run(
      { id: 'call-spawn', name: 'spawn_researcher', input: { topic: 'SSA' } },
      makeCtx()
    )
    assert.equal(spawned.status, 'ok')
    assert.match(spawned.content, /Started subagent/)

    // Turn hook detects running child and proposes synthetic auto-wait
    const hook = subagents.capability.turnHooks?.onTurnEndWithoutToolCalls?.({
      sessionId: 's1',
      replyId: 'r1',
      readReplyState: () => persistedState,
      writeReplyState: (next) => {
        persistedState = next
      },
    })
    assert.equal(hook?.syntheticCall.name, WAIT_TOOL_NAME)

    // Wait collects the finished child, board finding, and renumbers citations starting at [ref:2]
    const waited = await registryRef.run(
      { id: 'call-wait', name: WAIT_TOOL_NAME, input: { until: 'all' } },
      makeCtx()
    )
    assert.equal(waited.status, 'ok')
    assert.match(waited.content, /Alpha result \[ref:2\]/)
    assert.match(waited.content, /Found key metric/)
    assert.equal(waited.sources?.[0]?.url, 'https://example.com/a')
    assert.equal(forbiddenCalls.length, 0, 'non-read tool was never invoked')
    assert.ok(isSubagentsReplyState(persistedState))
    assert.equal(persistedState.agents[0]?.state.status, 'finished')

    // Child inherited provider.defaultModel and sent environmentContext inside a standard user message.
    const firstChildReq = childRequests[0] as {
      model: string
      messages: { role: string; content: string }[]
    }
    assert.equal(firstChildReq.model, 'deepseek-flash')
    assert.equal(firstChildReq.messages.length, 1)
    assert.equal(firstChildReq.messages[0]?.role, 'user')
    assert.match(firstChildReq.messages[0]?.content ?? '', /^<environment_context>/)
    assert.match(firstChildReq.messages[0]?.content ?? '', /Investigate SSA/)

    // Hydration settles any persisted running child to stopped (interrupted)
    const settled = settleHydratedSubagentsState({
      agents: [
        {
          runId: 'a1',
          profile: 'spawn_researcher',
          startedBy: 'c1',
          state: { status: 'running', round: 2 },
          blocks: [],
        },
      ],
      board: [],
    })
    assert.deepEqual(settled.agents[0]?.state, { status: 'stopped', reason: 'interrupted' })

    // Pure citation numbering works standalone
    const numbered = assignChildCitations(
      'See [1].',
      [{ n: 1, url: 'https://b.test', title: 'B', verification: 'verified' }],
      new Map([['https://a.test', 1]])
    )
    assert.match(numbered.content, /See \[ref:2\]\./)

    subagents.dispose()
  })
})
