import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import type { ToolEffect, ToolKind } from '@deepseek-chat/slice-conversations'
import { createStoreEnv, seeded, type ApiReply, type ApiRequest } from './store_harness.js'

const MAX_PARALLEL = 3

const KINDS: Record<string, ToolKind> = {
  r_search: 'web_search',
  r_scrape: 'web_scrape',
  r_file: 'read_file',
  w_file: 'present_file',
  s_py: 'python',
  i_ask: 'ask_user',
}

const EFFECTS: Record<string, ToolEffect> = {
  r_search: 'read',
  r_scrape: 'read',
  r_file: 'read',
  w_file: 'artifact',
  s_py: 'session',
  i_ask: 'interactive',
}

const TOOL_NAMES = Object.keys(KINDS)

const env = createStoreEnv({
  kinds: KINDS,
  effects: EFFECTS,
  params: { maxParallelReadCalls: MAX_PARALLEL },
})

const delay = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms))

const lastReply = () => {
  const { activeId } = env.slice.getState()
  assert.ok(activeId)
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
              ? [[part.tool_use_id, String(part.content ?? '')] as const]
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

describe('conversations store: tool effects and concurrency (SPEC invariant 2)', () => {
  it('writes tool_results in call order under random completion delays and saves each when it ends', async () => {
    await env.slice.commands.init()

    for (let seed = 1; seed <= 12; seed += 1) {
      const rand = seeded(seed * 97)
      const count = 4 + Math.floor(rand() * 4)
      const calls = Array.from({ length: count }, (_, idx) => ({
        name: ['r_search', 'r_scrape', 'r_file'][idx % 3] ?? 'r_search',
        input: { idx, delayMs: 2 + Math.floor(rand() * 20) },
      }))
      const script: ApiReply[] = [{ calls }, { text: 'done' }]
      env.respondWith(() => script.shift() ?? { text: 'extra' })

      const requestsBefore = env.requests.length
      const runsBefore = env.runs.length
      env.runToolsWith(async (call) => {
        const { idx, delayMs } = call.input as { idx: number; delayMs: number }
        await delay(delayMs)
        return { content: `res-${idx}`, status: 'ok' }
      })

      await turn(`order seed ${seed}`)

      const runs = env.runs.slice(runsBefore)
      const reply = lastReply()
      const resultBlocks = reply.blocks.filter((block) => block.type === 'tool_result')
      assert.deepEqual(
        resultBlocks.map((b) => [b.tool_use_id, b.content]),
        runs.map((r, idx) => [r.call.id, `res-${idx}`]),
        `seed ${seed}: stored tool_result order matches call order`
      )
      const followUp = env.requests[requestsBefore + 1]
      assert.ok(followUp)
      assert.deepEqual(
        resultsSent(followUp),
        runs.map((r, idx) => [r.call.id, `res-${idx}`]),
        `seed ${seed}: sent tool_result order matches call order`
      )
    }

    // Verify a fast later read result is written to state before a slow earlier read finishes.
    let releaseSlow!: () => void
    const slowGate = new Promise<void>((resolve) => {
      releaseSlow = resolve
    })
    let fastSettled = false
    const script: ApiReply[] = [
      {
        calls: [
          { name: 'r_search', input: { which: 'slow' } },
          { name: 'r_scrape', input: { which: 'fast' } },
        ],
      },
      { text: 'ok' },
    ]
    env.respondWith(() => script.shift() ?? { text: 'extra' })
    env.runToolsWith(async (call) => {
      const { which } = call.input as { which: string }
      if (which === 'slow') {
        await slowGate
        return { content: 'slow-done', status: 'ok' }
      }
      await delay(5)
      fastSettled = true
      return { content: 'fast-done', status: 'ok' }
    })

    env.slice.commands.newChat()
    env.slice.commands.setDraft(null, 'early save check')
    env.slice.commands.send(null)
    while (!fastSettled) {
      await delay(2)
    }
    await delay(2)
    const midReply = lastReply()
    const midResults = midReply.blocks.filter((b) => b.type === 'tool_result')
    assert.equal(midResults.length, 2)
    assert.equal(midResults[0]?.status, 'running')
    assert.equal(midResults[1]?.status, 'ok')
    assert.equal(midResults[1]?.content, 'fast-done')

    releaseSlow()
    await env.slice.commands.whenIdle()
    assert.equal(lastReply().status, 'done')
  })

  it('runs consecutive reads concurrently up to the cap and never overlaps non-read calls (randomized)', async () => {
    let sawConcurrentReads = false

    for (let seed = 1; seed <= 15; seed += 1) {
      const rand = seeded(seed * 313)
      const count = 6 + Math.floor(rand() * 6)
      const calls = Array.from({ length: count }, (_, idx) => {
        const name = TOOL_NAMES[Math.floor(rand() * TOOL_NAMES.length)] ?? 'r_search'
        return { name, input: { idx, delayMs: 4 + Math.floor(rand() * 10) } }
      })
      const script: ApiReply[] = [{ calls }, { text: 'done' }]
      env.respondWith(() => script.shift() ?? { text: 'extra' })

      const active = new Map<string, ToolEffect>()
      let maxInFlightReads = 0
      env.runToolsWith(async (call) => {
        const effect = EFFECTS[call.name] ?? 'session'
        if (effect !== 'read') {
          assert.equal(
            active.size,
            0,
            `seed ${seed}: non-read ${call.name} (${effect}) overlapped ${[...active.values()]}`
          )
        } else {
          for (const other of active.values()) {
            assert.equal(other, 'read', `seed ${seed}: read overlapped non-read ${other}`)
          }
        }
        active.set(call.id, effect)
        if (effect === 'read') {
          if (active.size > 1) {
            sawConcurrentReads = true
          }
          if (active.size > maxInFlightReads) {
            maxInFlightReads = active.size
          }
          assert.ok(
            active.size <= MAX_PARALLEL,
            `seed ${seed}: ${active.size} reads exceeded cap ${MAX_PARALLEL}`
          )
        }
        await delay((call.input as { delayMs: number }).delayMs)
        active.delete(call.id)
        return { content: 'ok', status: 'ok' }
      })

      await turn(`mix seed ${seed}`)
      assert.equal(active.size, 0)
      assert.ok(maxInFlightReads <= MAX_PARALLEL)
    }

    assert.equal(sawConcurrentReads, true, 'consecutive read calls actually overlapped')
  })

  it('aborts cleanly during concurrent reads without starting queued calls or making another request', async () => {
    const calls = Array.from({ length: MAX_PARALLEL + 3 }, (_, idx) => ({
      name: 'r_search',
      input: { idx },
    }))
    env.respondWith(() => ({ calls }))

    const runsBefore = env.runs.length
    const requestsBefore = env.requests.length
    env.runToolsWith(async (call, context) => {
      const { idx } = call.input as { idx: number }
      if (idx === 1) {
        env.slice.stopReply(context.sessionId)
      }
      await delay(5)
      return { content: `r${idx}`, status: context.signal.aborted ? 'aborted' : 'ok' }
    })

    await turn('abort concurrent reads')

    const ran = env.runs.slice(runsBefore).map((r) => (r.call.input as { idx: number }).idx)
    assert.ok(ran.length <= MAX_PARALLEL, `queued calls did not start after abort (ran: ${ran})`)
    assert.equal(env.requests.length, requestsBefore + 1, 'no request after abort')
    assert.equal(lastReply().status, 'stopped')
  })
})
