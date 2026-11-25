import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import type { ToolEffect, ToolRunResult } from '@deepseek-chat/lib-tools'
import { buildReplyView, type StreamTrace } from '@deepseek-chat/slice-conversations'
import { createStoreEnv, seeded, type ApiReply, type ApiRequest } from './store_harness.js'

const EFFECTS: Record<string, ToolEffect> = {
  find_web: 'read',
  read_web: 'read',
  run_code: 'session',
  make_doc: 'artifact',
  click_page: 'session',
}
const TOOL_NAMES = Object.keys(EFFECTS)
const NAMES = [...TOOL_NAMES, 'mystery_tool']
const instructionsFor = (names: ReadonlySet<string>) =>
  [...names]
    .sort()
    .map((name) => `## How to use ${name}`)
    .join('\n\n')

const env = createStoreEnv({
  toolNames: TOOL_NAMES,
  effects: EFFECTS,
  initialProgress: (name) => (name === 'run_code' ? { phase: 'starting' } : undefined),
  instructions: instructionsFor,
})

const lastReply = () => {
  const { activeId } = env.slice.getState()
  assert.ok(activeId, 'a chat is on screen')
  const reply = env.slice.getChatMessages(activeId).at(-1)
  assert.equal(reply?.role, 'assistant')
  return reply.role === 'assistant' ? reply : assert.fail()
}

const resultsSent = (request: ApiRequest) =>
  request.messages.flatMap((message) =>
    Array.isArray(message.content)
      ? (message.content as { type: string; tool_use_id?: string; content?: unknown }[]).flatMap(
          (part) =>
            part.type === 'tool_result'
              ? [
                  [
                    part.tool_use_id,
                    typeof part.content === 'string'
                      ? part.content
                      : (part.content as { type: string; text?: string }[])
                          .map((c) => c.text ?? '')
                          .join(''),
                  ],
                ]
              : []
        )
      : []
  )

const turn = async (text: string) => {
  env.slice.commands.newChat()
  env.slice.commands.setDraft(null, text)
  assert.equal(env.slice.commands.send(null), true)
  await env.slice.commands.whenIdle()
}

describe('conversations store: the tool-call loop', () => {
  it('runs every call once, in order, and returns each result to the model (randomized)', async () => {
    await env.slice.commands.init()
    for (let seed = 1; seed <= 25; seed += 1) {
      const random = seeded(seed)
      const rounds: { name: string; input: { n: number } }[][] = Array.from(
        { length: 1 + Math.floor(random() * 4) },
        () =>
          Array.from({ length: 1 + Math.floor(random() * 3) }, () => ({
            name: NAMES[Math.floor(random() * NAMES.length)] ?? 'mystery_tool',
            input: { n: Math.floor(random() * 1000) },
          }))
      )
      const script: ApiReply[] = [...rounds.map((calls) => ({ calls })), { text: `done ${seed}` }]
      env.respondWith(() => script.shift() ?? { text: 'extra' })
      const results = new Map<string, ToolRunResult>()
      env.runToolsWith(async (call) => {
        const result: ToolRunResult = {
          content: `${call.name}#${(call.input as { n: number }).n}@${seed}`,
          status: random() < 0.3 ? 'error' : 'ok',
        }
        results.set(call.id, result)
        return result
      })
      const runsBefore = env.runs.length
      const requestsBefore = env.requests.length

      await turn(`question ${seed}`)

      const runs = env.runs.slice(runsBefore)
      const planned = rounds.flat()
      // Only registered tools invoke the capability handler; unknown tools get an error result.
      const expectedRuns = planned.filter((c) => TOOL_NAMES.includes(c.name))
      assert.deepEqual(
        runs.map((run) => [run.call.name, run.call.input]),
        expectedRuns.map((call) => [call.name, call.input]),
        `seed ${seed}`
      )
      assert.equal(new Set(runs.map((run) => run.call.id)).size, expectedRuns.length)
      for (const run of runs) {
        assert.equal(
          run.initialPhase,
          run.call.name === 'run_code' ? 'starting' : undefined,
          `seed ${seed}: ${run.call.name}`
        )
      }
      const reply = lastReply()
      assert.equal(reply.status, 'done')
      for (const run of runs) {
        const useAt = reply.blocks.findIndex((b) => b.type === 'tool_use' && b.id === run.call.id)
        const resultAt = reply.blocks.findIndex(
          (b) => b.type === 'tool_result' && b.tool_use_id === run.call.id
        )
        assert.ok(useAt >= 0 && resultAt > useAt, `seed ${seed}: result follows its call`)
        const block = reply.blocks[resultAt]
        const expected = results.get(run.call.id)
        assert.ok(block?.type === 'tool_result' && expected)
        assert.equal(block.content, expected.content)
        assert.equal(block.status, expected.status)
      }
      const requests = env.requests.slice(requestsBefore)
      assert.equal(requests.length, rounds.length + 1)
    }
  })

  it('builds the system prompt from the identity and the declared tools’ instructions', async () => {
    env.respondWith(() => ({ text: 'hi' }))
    const before = env.requests.length
    await turn('prompt check')
    const request = env.requests[before]
    assert.ok(request)
    const declared = new Set(request.tools.map((tool) => tool.name))
    assert.deepEqual([...declared].sort(), [...TOOL_NAMES].sort())
    const sections = instructionsFor(declared)
    assert.ok(request.system.endsWith(`\n\n${sections}`))
    assert.ok(request.system.length > sections.length + 2)
    assert.ok(!request.system.includes('—'), 'core system prompt must not contain em dashes')
    await turn('second prompt check')
    const second = env.requests[before + 1]
    assert.equal(second?.system, request.system, 'core system prompt stays static across turns')
  })

  it('stops after the current call when the turn is aborted during it', async () => {
    env.respondWith(() => ({
      calls: [
        { name: 'make_doc', input: { n: 1 } },
        { name: 'make_doc', input: { n: 2 } },
        { name: 'make_doc', input: { n: 3 } },
      ],
    }))
    const runsBefore = env.runs.length
    let requestsAtAbort = -1
    env.runToolsWith(async (call, context) => {
      if ((call.input as { n: number }).n === 2) {
        env.slice.stopReply(context.sessionId)
        requestsAtAbort = env.requests.length
      }
      return { content: 'ok', status: 'ok' }
    })
    await turn('abort me')
    const ran = env.runs.slice(runsBefore).map((run) => (run.call.input as { n: number }).n)
    assert.deepEqual(ran, [1, 2])
    assert.equal(env.requests.length, requestsAtAbort, 'no request after the abort')
    assert.equal(lastReply().status, 'stopped')
  })

  it('reports one trace per request, with sizes and timings but no content', async () => {
    const secret = 'TOP-SECRET-FILE-BODY'
    env.respondWith((request) =>
      resultsSent(request).length === 0
        ? { calls: [{ name: 'make_doc', input: { body: secret } }] }
        : { text: `answer ${secret}` }
    )
    env.runToolsWith(async () => ({ content: 'ok', status: 'ok' }))
    const before = env.traces.length
    await turn('trace check')
    const traces = env.traces.slice(before)
    assert.deepEqual(
      traces.map((trace) => [trace.round, trace.stopReason, trace.error]),
      [
        [0, 'tool_use', undefined],
        [1, 'end_turn', undefined],
      ]
    )
    const [toolRound, answer] = traces as [StreamTrace, StreamTrace]
    const input = JSON.stringify({ body: secret })
    assert.deepEqual(
      toolRound.blocks.map((b) => [b.type, b.deltas, b.chars]),
      [['tool_use:make_doc', 1, input.length]]
    )
    assert.deepEqual(
      answer.blocks.map((b) => [b.type, b.chars]),
      [['text', `answer ${secret}`.length]]
    )
    for (const trace of traces) {
      assert.ok(!JSON.stringify(trace).includes(secret), 'no content in a trace')
      const block = trace.blocks[0]
      assert.ok(trace.firstEventMs !== null && block?.stopMs != null)
      assert.ok(trace.firstEventMs <= block.startMs && block.startMs <= block.stopMs)
      assert.ok(block.stopMs <= trace.endMs)
    }
  })

  it('ends a turn whose model never stops calling tools', { timeout: 20_000 }, async () => {
    env.respondWith(() => ({ calls: [{ name: 'click_page', input: { n: 0 } }] }))
    env.runToolsWith(async () => ({ content: 'clicked', status: 'ok' }))
    const before = env.requests.length
    await turn('loop forever')
    const reply = lastReply()
    assert.notEqual(reply.status, 'pending')
    assert.notEqual(reply.status, 'streaming')
    assert.ok(env.requests.length > before + 1, 'it did loop')
    assert.deepEqual(env.slice.getState().replying, [])
  })

  it('gives a run on-screen state and live progress updates', async () => {
    env.respondWith((request) =>
      resultsSent(request).length === 0
        ? { calls: [{ name: 'make_doc', input: { n: 7 } }] }
        : { text: 'saved' }
    )
    const seen: Record<string, unknown> = {}
    env.runToolsWith(async (_call, context) => {
      seen.activeBefore = context.isActive()
      context.onProgress({ phase: 'writing', detail: 'step 1' })
      const snap = env.slice.getTurnSnapshot(context.sessionId, context.replyId)
      const running = snap?.blocks.find((b) => b.type === 'tool_result')
      seen.livePhase = running?.type === 'tool_result' ? running.progress?.phase : undefined
      env.slice.commands.newChat()
      seen.activeAfter = context.isActive()
      return { content: 'ok', status: 'ok' }
    })
    await turn('context check')
    assert.equal(seen.activeBefore, true)
    assert.equal(seen.livePhase, 'writing')
    assert.equal(seen.activeAfter, false)
  })

  it('reconciles citation numbers in call order across concurrent read tool batches', async () => {
    env.respondWith((request) =>
      resultsSent(request).length === 0
        ? {
            calls: [
              { name: 'find_web', input: { query: 'first' } },
              { name: 'read_web', input: { url: 'https://scraped.example' } },
              { name: 'find_web', input: { query: 'second' } },
            ],
          }
        : { text: 'Grounded[ref:1][ref:3][ref:4].' }
    )

    const format =
      (sources: { url: string; title: string }[]) => (map: ReadonlyMap<string, number>) =>
        sources.map((s) => `[${map.get(s.url) ?? '?'}] ${s.title}\nURL: ${s.url}`).join('\n\n')

    env.runToolsWith(async (call) => {
      if (call.name === 'read_web') {
        await new Promise((r) => setTimeout(r, 15))
        return {
          status: 'ok',
          content: 'Title: Scraped\nBody',
          sources: [
            {
              url: 'https://scraped.example',
              title: 'Scraped',
              snippet: '',
              siteName: 'scraped.example',
              publishedAt: null,
            },
          ],
        }
      }
      const query = (call.input as { query: string }).query
      if (query === 'first') {
        await new Promise((r) => setTimeout(r, 30))
        const sources = [
          {
            url: 'https://a.example',
            title: 'A',
            snippet: 'sa',
            siteName: 'a.example',
            publishedAt: null,
          },
          {
            url: 'https://b.example',
            title: 'B',
            snippet: 'sb',
            siteName: 'b.example',
            publishedAt: null,
          },
        ]
        return {
          status: 'ok',
          content: 'unnumbered',
          sources,
          formatContentWithCitations: format(sources),
        }
      }
      const sources = [
        {
          url: 'https://b.example',
          title: 'B',
          snippet: 'sb',
          siteName: 'b.example',
          publishedAt: null,
        },
        {
          url: 'https://c.example',
          title: 'C',
          snippet: 'sc',
          siteName: 'c.example',
          publishedAt: null,
        },
      ]
      return {
        status: 'ok',
        content: 'unnumbered',
        sources,
        formatContentWithCitations: format(sources),
      }
    })

    const requestsBefore = env.requests.length
    await turn('concurrent citation check')
    const reply = lastReply()
    const view = buildReplyView(reply, false, env.tools)

    assert.deepEqual(
      view.sources.map((s) => [s.index, s.url]),
      [
        [1, 'https://a.example'],
        [2, 'https://b.example'],
        [3, 'https://scraped.example'],
        [4, 'https://c.example'],
      ]
    )

    const followUp = env.requests[requestsBefore + 1]
    assert.ok(followUp)
    const sent = resultsSent(followUp)
    assert.equal(sent.length, 3)
    assert.match(sent[0]?.[1] ?? '', /^\[1\] A\nURL: https:\/\/a\.example/m)
    assert.match(sent[0]?.[1] ?? '', /^\[2\] B\nURL: https:\/\/b\.example/m)
    assert.match(sent[2]?.[1] ?? '', /^\[2\] B\nURL: https:\/\/b\.example/m)
    assert.match(sent[2]?.[1] ?? '', /^\[4\] C\nURL: https:\/\/c\.example/m)
  })
})
