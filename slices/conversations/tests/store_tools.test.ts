import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import type { ToolKind, ToolResult } from '@deepseek-chat/slice-conversations'
import { createStoreEnv, seeded, type ApiReply, type ApiRequest } from './store_harness.js'

// Tool names unlike the real ones: the store must rely on the gateway alone.
const KINDS: Record<string, ToolKind> = {
  find_web: 'web_search',
  run_code: 'python',
  make_doc: 'present_file',
  click_page: 'browser',
}
const NAMES = [...Object.keys(KINDS), 'mystery_tool'] // the last one has no kind
const instructionsFor = (names: ReadonlySet<string>) =>
  [...names].sort().map((name) => `## How to use ${name}`)

const env = createStoreEnv({ kinds: KINDS, instructions: instructionsFor })

/** The reply on screen after a turn. */
const lastReply = () => {
  const { activeId } = env.slice.getState()
  assert.ok(activeId, 'a chat is on screen')
  const reply = env.slice.getChatMessages(activeId).at(-1)
  assert.equal(reply?.role, 'assistant')
  return reply.role === 'assistant' ? reply : assert.fail()
}

/** Tool results as a request sends them back: `[tool_use_id, text]` in message order. */
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

/** Starts a new chat turn and waits for it to end. */
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
      // The model's plan for this turn: 1–4 rounds of 1–3 calls, then an answer.
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
      const results = new Map<string, ToolResult>()
      env.runToolsWith(async (call) => {
        const result: ToolResult = {
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
      // Exactly once each, in the order the model made them.
      assert.deepEqual(
        runs.map((run) => [run.call.name, run.call.input]),
        planned.map((call) => [call.name, call.input]),
        `seed ${seed}`
      )
      assert.equal(new Set(runs.map((run) => run.call.id)).size, planned.length)
      // Running phase: `starting` exactly for python-kind calls.
      for (const run of runs) {
        assert.equal(
          run.runningPhase,
          KINDS[run.call.name] === 'python' ? 'starting' : undefined,
          `seed ${seed}: ${run.call.name}`
        )
      }
      // The stored reply: each call's result block holds the gateway's result, after its call.
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
      // One request per round plus the answer; each follow-up sends all results so far, in order.
      const requests = env.requests.slice(requestsBefore)
      assert.equal(requests.length, rounds.length + 1)
      let sentSoFar = 0
      rounds.forEach((calls, index) => {
        sentSoFar += calls.length
        const followUp = requests[index + 1]
        assert.ok(followUp)
        const expected = runs
          .slice(0, sentSoFar)
          .map((run) => [run.call.id, results.get(run.call.id)?.content])
        assert.deepEqual(resultsSent(followUp), expected, `seed ${seed}, round ${index + 1}`)
      })
    }
  })

  it('builds the system prompt from the identity and the declared tools’ instructions', async () => {
    env.respondWith(() => ({ text: 'hi' }))
    const before = env.requests.length
    await turn('prompt check')
    const request = env.requests[before]
    assert.ok(request)
    const declared = new Set(request.tools.map((tool) => tool.name))
    assert.deepEqual([...declared].sort(), Object.keys(KINDS).sort())
    const sections = instructionsFor(declared).join('\n\n')
    assert.ok(request.system.endsWith(`\n\n${sections}`))
    // Something (the identity) comes first.
    assert.ok(request.system.length > sections.length + 2)
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

  it('gives a run the visible branch with the reply last, on-screen state and the file store', async () => {
    env.respondWith((request) =>
      resultsSent(request).length === 0
        ? { calls: [{ name: 'make_doc', input: { n: 7 } }] }
        : { text: 'saved' }
    )
    const seen: Record<string, unknown> = {}
    env.runToolsWith(async (_call, context) => {
      const messages = context.messages
      seen.roles = messages.map((m) => m.role)
      seen.lastIsReplyInProgress =
        messages.at(-1)?.role === 'assistant' &&
        (messages.at(-1) as { status: string }).status !== 'done'
      const question = messages.at(-2)
      seen.questionText = question?.role === 'user' ? question.content : null
      seen.activeBefore = context.isActive()
      env.slice.commands.newChat()
      seen.activeAfter = context.isActive()
      await context.saveFiles([{ id: 'file-ctx-1', blob: new Blob(['stored bytes']) }])
      return { content: 'ok', status: 'ok' }
    })
    await turn('context check')
    assert.deepEqual(seen.roles, ['user', 'assistant'])
    assert.equal(seen.lastIsReplyInProgress, true)
    assert.equal(seen.questionText, 'context check')
    assert.equal(seen.activeBefore, true)
    assert.equal(seen.activeAfter, false)
    assert.equal(await (await env.slice.loadFile('file-ctx-1'))?.text(), 'stored bytes')
  })
})
