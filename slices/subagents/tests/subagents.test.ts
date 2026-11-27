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
  createSubagentsSlice,
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

    const childHost = createToolRegistry([providerCap])
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
      toolHost: childHost,
    })

    const registryRef = createToolRegistry([providerCap, subagents.capability])

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
    const saved = persistedState as {
      agents: { state: { status: string } }[]
      board: unknown[]
    }
    assert.ok(Array.isArray(saved?.agents) && Array.isArray(saved?.board))
    assert.equal(saved.agents[0]?.state.status, 'finished')

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

    // Hydration settles any persisted running child to stopped (interrupted) through turnHooks.onReplyHydrated.
    const settled = subagents.capability.turnHooks?.onReplyHydrated?.({
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
    }) as { agents: { state: unknown }[] }
    assert.deepEqual(settled.agents[0]?.state, { status: 'stopped', reason: 'interrupted' })

    subagents.dispose()
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

type Deferred<T> = { promise: Promise<T>; resolve: (value: T) => void }
const deferred = <T>(): Deferred<T> => {
  let resolve: (value: T) => void = () => undefined
  const promise = new Promise<T>((r) => {
    resolve = r
  })
  return { promise, resolve }
}

describe('slice-subagents: randomized caps, read-only guard, board isolation, citations, & lifecycle (SPEC 1-6)', () => {
  it('enforces caps, zero privilege escalation, audience-scoped exact-once board drains, contiguous citations, and zero orphans across 20 seeds', async () => {
    const URL_POOL = [
      'https://alpha.test/1',
      'https://beta.test/2',
      'https://gamma.test/3',
      'https://delta.test/4',
      'https://epsilon.test/5',
      'https://zeta.test/6',
    ]

    for (let seed = 1; seed <= 20; seed += 1) {
      const rand = seeded(seed * 613 + 29)
      const nextInt = (max: number) => Math.floor(rand() * max)
      const maxRunningChildren = 2 + nextInt(2) // 2..3
      const maxChildrenPerReply = maxRunningChildren + 1 + nextInt(3) // 3..6
      const maxPostsPerChild = 2 + nextInt(2) // 2..3
      const maxPostChars = 60 + nextInt(40) // 60..99

      const forbiddenCalls: string[] = []
      let activeChildScripts = 0
      let peakActiveChildren = 0
      const childInboxesByTopic = new Map<string, string[]>()
      const childGates = new Map<string, Deferred<undefined>>()
      const childPlannedSources = new Map<string, { n: number; url: string; title: string }[]>()
      const childPostPayloads = new Map<
        string,
        { kind: 'finding' | 'question'; marker: string }[]
      >()

      const profile: AgentProfileSpec = {
        thinking: false,
        label: 'Rand Researcher',
        system: 'Research.',
        tools: ['read_item', 'write_item', 'spawn_researcher'],
        context: 'clean',
        finish: {
          name: 'finish_task',
          description: 'Finish.',
          input_schema: {
            type: 'object',
            required: ['answer', 'sources'],
            properties: { answer: { type: 'string' }, sources: { type: 'array' } },
          },
        },
        limits: { maxRounds: 5, maxToolCalls: 12 },
        task: (input) => {
          const topic =
            input && typeof (input as { topic?: unknown }).topic === 'string'
              ? (input as { topic: string }).topic.trim()
              : ''
          return topic
            ? { kind: 'ok', message: `TOPIC:${topic}` }
            : { kind: 'invalid', reason: 'empty' }
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
            description: 'Spawn',
            input_schema: { type: 'object', properties: { topic: { type: 'string' } } },
          },
          {
            name: 'read_item',
            description: 'Read',
            input_schema: { type: 'object', properties: { id: { type: 'string' } } },
          },
          {
            name: 'write_item',
            description: 'Write (forbidden)',
            input_schema: { type: 'object', properties: {} },
          },
        ],
        instructions: () => null,
        handles: (name) => name === 'read_item' || name === 'write_item',
        effectOf: (name) =>
          name === 'read_item' ? 'read' : name === 'spawn_researcher' ? 'spawn' : 'session',
        agentProfile: (name) => (name === 'spawn_researcher' ? profile : null),
        run: async (call) => {
          if (call.name !== 'read_item') {
            forbiddenCalls.push(call.name)
          }
          return { status: 'ok', content: `ok:${JSON.stringify(call.input)}` }
        },
      }

      const childHost = createToolRegistry([providerCap])
      const log = new EventLog()
      const roundByTopic = new Map<string, number>()

      const subagents = createSubagentsSlice({
        log,
        params: {
          maxRunningChildren,
          maxChildrenPerReply,
          maxPostsPerChild,
          maxPostChars,
          retryBaseDelayMs: 1,
          waitDefaultTimeoutS: 1,
        },
        provider: createDeepSeekProvider({
          apiOrigin: 'https://api.test',
          getApiKey: () => 'sk-test',
          fetch: async (_url, init) => {
            const body = JSON.parse(String(init.body)) as {
              messages: {
                role: string
                content: string | { type: string; text?: string; content?: string }[]
              }[]
            }
            const firstMsg = body.messages[0]?.content
            const firstText = typeof firstMsg === 'string' ? firstMsg : ''
            const topicMatch = /TOPIC:(\S+)/.exec(firstText)
            const topic = topicMatch?.[1] ?? 'unknown'
            const round = (roundByTopic.get(topic) ?? 0) + 1
            roundByTopic.set(topic, round)

            // Collect any board digest injected into any user message (string, text block, or tool_result content).
            const digests: string[] = []
            for (const msg of body.messages) {
              if (msg.role !== 'user') {
                continue
              }
              if (typeof msg.content === 'string' && msg.content.includes('On the board')) {
                digests.push(msg.content)
              } else if (Array.isArray(msg.content)) {
                for (const part of msg.content) {
                  const txt =
                    part.type === 'text'
                      ? part.text
                      : part.type === 'tool_result'
                        ? part.content
                        : undefined
                  if (txt && txt.includes('On the board')) {
                    digests.push(txt)
                  }
                }
              }
            }
            if (digests.length > 0) {
              childInboxesByTopic.set(topic, [
                ...(childInboxesByTopic.get(topic) ?? []),
                ...digests,
              ])
            }

            if (round === 1) {
              activeChildScripts += 1
              peakActiveChildren = Math.max(peakActiveChildren, activeChildScripts)
              const gate = childGates.get(topic)
              if (gate) {
                const signal = init.signal
                await Promise.race([
                  gate.promise,
                  new Promise<void>((resolve) => {
                    if (signal?.aborted) {
                      resolve()
                    } else {
                      signal?.addEventListener('abort', () => resolve(), { once: true })
                    }
                  }),
                ])
              }
              if (init.signal?.aborted) {
                activeChildScripts -= 1
                throw new DOMException('Aborted', 'AbortError')
              }

              // Round 1 batch: valid read + forbidden write + forbidden recursive spawn + posts (including over-cap & over-char)
              const calls: { id: string; name: string; input: unknown }[] = [
                { id: `${topic}-r1`, name: 'read_item', input: { id: topic } },
                { id: `${topic}-bad1`, name: 'write_item', input: {} },
                { id: `${topic}-bad2`, name: 'spawn_researcher', input: { topic: 'nested' } },
              ]
              const postsForChild = childPostPayloads.get(topic) ?? []
              for (let p = 0; p < postsForChild.length; p += 1) {
                const post = postsForChild[p]
                if (!post) {
                  continue
                }
                calls.push({
                  id: `${topic}-p${p}`,
                  name: POST_TOOL_NAME,
                  input:
                    post.kind === 'finding'
                      ? { kind: 'finding', text: post.marker, url: URL_POOL[p % URL_POOL.length] }
                      : { kind: 'question', question: post.marker, assumption: 'continue' },
                })
              }
              // Always attempt one over-length post and one extra post past cap to test rejection.
              calls.push({
                id: `${topic}-overlen`,
                name: POST_TOOL_NAME,
                input: { kind: 'finding', text: 'X'.repeat(maxPostChars + 5), url: URL_POOL[0] },
              })
              return toolCallStream(calls)
            }

            activeChildScripts -= 1
            const srcs = childPlannedSources.get(topic) ?? []
            const refs = srcs.map((s) => `[${s.n}]`).join(' ')
            return toolCallStream([
              {
                id: `${topic}-fin`,
                name: 'finish_task',
                input: { answer: `Done ${topic} ${refs}`, sources: srcs },
              },
            ])
          },
        }),
        toolHost: childHost,
      })

      const registry = createToolRegistry([providerCap, subagents.capability])
      let persistedState: unknown
      const initialCited = new Map<string, number>([['https://prior.test/0', 1]])
      const refCited = new Map(initialCited)

      const makeCtx = (): ToolRunContext => ({
        sessionId: `s-${seed}`,
        replyId: `r-${seed}`,
        signal: new AbortController().signal,
        caller: { kind: 'reply' },
        citedUrls: refCited,
        isActive: () => true,
        onProgress: () => undefined,
        readReplyState: () => persistedState as never,
        writeReplyState: (next) => {
          persistedState = next
        },
      })

      // Invalid spawn must fail without consuming reply cap.
      const badSpawn = await registry.run(
        { id: 'bad-spawn', name: 'spawn_researcher', input: { topic: '   ' } },
        makeCtx()
      )
      assert.equal(badSpawn.status, 'error', `seed ${seed}: blank topic rejected`)

      const spawnedRunIds: { topic: string; runId: string }[] = []
      const directedTopics = new Set<string>()
      const deliveredRunIds = new Set<string>()
      const expectedRefUrls = new Map(initialCited)
      let spawnAttempt = 0
      let runningRef = 0

      // Spawn up to maxChildrenPerReply + 2 attempts across waves.
      while (spawnAttempt < maxChildrenPerReply + 2) {
        spawnAttempt += 1
        const topic = `t${seed}_${spawnAttempt}`
        const gate = deferred<undefined>()
        childGates.set(topic, gate)

        const srcCount = 1 + nextInt(3)
        const srcs: { n: number; url: string; title: string }[] = []
        const usedUrls = new Set<string>()
        for (let k = 0; k < srcCount; k += 1) {
          const url = URL_POOL[nextInt(URL_POOL.length)] ?? URL_POOL[0] ?? 'https://alpha.test/1'
          if (usedUrls.has(url)) {
            continue
          }
          usedUrls.add(url)
          srcs.push({ n: srcs.length + 1, url, title: `Doc ${url}` })
        }
        childPlannedSources.set(topic, srcs)

        const postCount = 1 + nextInt(maxPostsPerChild + 1) // deliberately hits cap on some children
        const plannedPosts: { kind: 'finding' | 'question'; marker: string }[] = []
        for (let p = 0; p < postCount; p += 1) {
          plannedPosts.push({
            kind: p === 0 && rand() < 0.4 ? 'question' : 'finding',
            marker: `M_${topic}_${p}`,
          })
        }
        childPostPayloads.set(topic, plannedPosts)

        const res = await registry.run(
          { id: `sp-${spawnAttempt}`, name: 'spawn_researcher', input: { topic } },
          makeCtx()
        )
        const shouldFailCap =
          runningRef >= maxRunningChildren || spawnedRunIds.length >= maxChildrenPerReply
        if (shouldFailCap) {
          assert.equal(
            res.status,
            'error',
            `seed ${seed}: cap should reject spawn #${spawnAttempt}`
          )
          // Release one running child and wait('any') to free a slot if under total cap.
          const toRelease = spawnedRunIds.find((item) => !deliveredRunIds.has(item.runId))
          if (toRelease && spawnedRunIds.length < maxChildrenPerReply) {
            // Test private lead direction to an active child AND unknown child rejection first.
            const dirUnknown = await registry.run(
              {
                id: `dir-unk-${spawnAttempt}`,
                name: POST_TOOL_NAME,
                input: {
                  kind: 'direction',
                  to: { kind: 'agent', runId: 'does-not-exist' },
                  text: 'hi',
                },
              },
              makeCtx()
            )
            assert.equal(
              dirUnknown.status,
              'error',
              `seed ${seed}: direction to unknown runId rejected`
            )

            const privateMarker = `PRIV_FOR_${toRelease.topic}`
            const dirOk = await registry.run(
              {
                id: `dir-ok-${spawnAttempt}`,
                name: POST_TOOL_NAME,
                input: {
                  kind: 'direction',
                  to: { kind: 'agent', runId: toRelease.runId },
                  text: privateMarker,
                },
              },
              makeCtx()
            )
            assert.equal(dirOk.status, 'ok', `seed ${seed}: direction to running child accepted`)
            directedTopics.add(toRelease.topic)

            childGates.get(toRelease.topic)?.resolve(undefined)
            const waited = await registry.run(
              {
                id: `wait-any-${spawnAttempt}`,
                name: WAIT_TOOL_NAME,
                input: { until: 'any', timeout_s: 2 },
              },
              makeCtx()
            )
            assert.equal(waited.status, 'ok')
            assert.ok(
              !waited.content.includes(privateMarker),
              `seed ${seed}: lead must never see its own direction`
            )

            // If a question woke wait early before the child finished, drain until this child finishes.
            let payload = waited.payload as { deliveredIds?: string[] } | undefined
            if (!payload?.deliveredIds?.includes(toRelease.runId)) {
              const waited2 = await registry.run(
                {
                  id: `wait-any2-${spawnAttempt}`,
                  name: WAIT_TOOL_NAME,
                  input: { until: 'any', timeout_s: 2 },
                },
                makeCtx()
              )
              payload = waited2.payload as { deliveredIds?: string[] } | undefined
              for (const src of waited2.sources ?? []) {
                if (!expectedRefUrls.has(src.url)) {
                  expectedRefUrls.set(src.url, expectedRefUrls.size + 1)
                }
                refCited.set(src.url, expectedRefUrls.get(src.url) ?? 1)
              }
            }
            for (const src of waited.sources ?? []) {
              if (!expectedRefUrls.has(src.url)) {
                expectedRefUrls.set(src.url, expectedRefUrls.size + 1)
              }
              refCited.set(src.url, expectedRefUrls.get(src.url) ?? 1)
            }
            for (const id of payload?.deliveredIds ?? []) {
              assert.equal(
                deliveredRunIds.has(id),
                false,
                `seed ${seed}: child ${id} delivered twice`
              )
              deliveredRunIds.add(id)
              runningRef = Math.max(0, runningRef - 1)
            }
          }
          continue
        }

        assert.equal(res.status, 'ok', `seed ${seed}: spawn #${spawnAttempt} should succeed`)
        const runId = (res.payload as { runId: string }).runId
        spawnedRunIds.push({ topic, runId })
        runningRef += 1

        // Orphan hook must propose auto-wait while any child is running.
        const hook = subagents.capability.turnHooks?.onTurnEndWithoutToolCalls?.({
          sessionId: `s-${seed}`,
          replyId: `r-${seed}`,
          readReplyState: () => persistedState,
          writeReplyState: (next) => {
            persistedState = next
          },
        })
        assert.equal(
          hook?.syntheticCall.name,
          WAIT_TOOL_NAME,
          `seed ${seed}: hook must propose wait while running`
        )
      }

      // Release all remaining children and wait('all') to collect every result.
      for (const item of spawnedRunIds) {
        childGates.get(item.topic)?.resolve(undefined)
      }
      const finalWait = await registry.run(
        { id: 'wait-all-final', name: WAIT_TOOL_NAME, input: { until: 'all', timeout_s: 3 } },
        makeCtx()
      )
      assert.equal(finalWait.status, 'ok')
      const finalDelivered =
        (finalWait.payload as { deliveredIds?: string[] } | undefined)?.deliveredIds ?? []
      for (const id of finalDelivered) {
        assert.equal(
          deliveredRunIds.has(id),
          false,
          `seed ${seed}: child ${id} delivered twice in final wait`
        )
        deliveredRunIds.add(id)
      }
      assert.equal(
        deliveredRunIds.size,
        spawnedRunIds.length,
        `seed ${seed}: every spawned child must be delivered exactly once`
      )

      // Check contiguous citation renumbering without gaps or duplicates.
      for (const src of finalWait.sources ?? []) {
        if (!expectedRefUrls.has(src.url)) {
          expectedRefUrls.set(src.url, expectedRefUrls.size + 1)
        }
        const expectedIdx = expectedRefUrls.get(src.url)
        assert.ok(
          expectedIdx !== undefined && finalWait.content.includes(`[ref:${expectedIdx}]`),
          `seed ${seed}: expected [ref:${expectedIdx}] for ${src.url}`
        )
      }

      // After all children finished, lead direction to a finished child must fail, and orphan hook returns null.
      const firstSpawn = spawnedRunIds[0]
      if (firstSpawn) {
        const dirEnded = await registry.run(
          {
            id: 'dir-ended',
            name: POST_TOOL_NAME,
            input: {
              kind: 'direction',
              to: { kind: 'agent', runId: firstSpawn.runId },
              text: 'late',
            },
          },
          makeCtx()
        )
        assert.equal(dirEnded.status, 'error', `seed ${seed}: direction to finished child rejected`)
      }
      const hookAfter = subagents.capability.turnHooks?.onTurnEndWithoutToolCalls?.({
        sessionId: `s-${seed}`,
        replyId: `r-${seed}`,
        readReplyState: () => persistedState,
        writeReplyState: (next) => {
          persistedState = next
        },
      })
      assert.equal(hookAfter, null, `seed ${seed}: no synthetic wait once all children finished`)

      // Verify hard cap, zero privilege escalation, board per-child cap, and audience isolation.
      assert.ok(
        peakActiveChildren <= maxRunningChildren,
        `seed ${seed}: peak running ${peakActiveChildren} exceeded maxRunningChildren=${maxRunningChildren}`
      )
      assert.equal(forbiddenCalls.length, 0, `seed ${seed}: non-read/spawn tools must never run`)

      const state = persistedState as {
        agents: { runId: string; state: { status: string } }[]
        board: {
          kind: string
          author: { kind: string; runId?: string }
          text?: string
          question?: string
          assumption?: string
        }[]
      }
      const postsByAuthor = new Map<string, number>()
      for (const post of state.board) {
        if (post.author.kind === 'agent' && post.author.runId) {
          const n = (postsByAuthor.get(post.author.runId) ?? 0) + 1
          postsByAuthor.set(post.author.runId, n)
          assert.ok(
            n <= maxPostsPerChild,
            `seed ${seed}: child ${post.author.runId} exceeded maxPostsPerChild=${maxPostsPerChild}`
          )
        }
        const len =
          post.kind === 'question'
            ? (post.question?.length ?? 0) + (post.assumption?.length ?? 0)
            : (post.text?.length ?? 0)
        assert.ok(len <= maxPostChars, `seed ${seed}: board post length ${len} > ${maxPostChars}`)
      }

      // Audience isolation: no child ever saw its own posts or another child's private direction,
      // and every directed child actually received its own private direction in its inbox.
      for (const item of spawnedRunIds) {
        const seen = (childInboxesByTopic.get(item.topic) ?? []).join('\n')
        assert.ok(
          !seen.includes(`M_${item.topic}_`),
          `seed ${seed}: child ${item.topic} saw its own post`
        )
        if (directedTopics.has(item.topic)) {
          assert.ok(
            seen.includes(`PRIV_FOR_${item.topic}`),
            `seed ${seed}: directed child ${item.topic} must receive its own private direction`
          )
        }
        for (const other of spawnedRunIds) {
          if (other.topic !== item.topic) {
            assert.ok(
              !seen.includes(`PRIV_FOR_${other.topic}`),
              `seed ${seed}: child ${item.topic} saw private direction for ${other.topic}`
            )
          }
        }
      }

      // Hydration settles only 'running' entries to stopped('interrupted'), preserving terminal states.
      const mixed = {
        agents: [
          {
            runId: 'r-run',
            profile: 'spawn_researcher',
            startedBy: 'c1',
            state: { status: 'running', round: 1 },
            blocks: [],
          },
          {
            runId: 'r-done',
            profile: 'spawn_researcher',
            startedBy: 'c2',
            state: { status: 'finished', result: { content: 'ok', sources: [] } },
            blocks: [],
          },
        ],
        board: [],
      }
      const hydrated = subagents.capability.turnHooks?.onReplyHydrated?.(mixed) as {
        agents: { runId: string; state: { status: string; reason?: string } }[]
      }
      assert.deepEqual(hydrated.agents[0]?.state, { status: 'stopped', reason: 'interrupted' })
      assert.equal(hydrated.agents[1]?.state.status, 'finished')

      subagents.dispose()
    }
  })
})
