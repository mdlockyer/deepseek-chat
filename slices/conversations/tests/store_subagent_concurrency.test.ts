import assert from 'node:assert/strict'
import { before, describe, it } from 'node:test'
import {
  POST_TOOL_NAME,
  WAIT_TOOL_NAME,
  type AgentProfile,
  type AgentSource,
  type ToolEffect,
  type ToolKind,
} from '@deepseek-chat/slice-conversations'
import { createStoreEnv, seeded, type ApiReply, type ApiRequest } from './store_harness.js'

// SPEC invariant 20, "Concurrency": a child's calls follow invariant 2's effect rules. The slice is
// created once per process, so this runs in its own file and env.

const MAX_PARALLEL = 3 // unlike the shipped 6, so the test follows the parameter

const FINISH_TOOL = {
  name: 'finish_task',
  description: 'Return findings and sources',
  input_schema: { type: 'object', properties: { answer: { type: 'string' } } },
}

const PROFILE: AgentProfile = {
  model: 'deepseek-flash',
  thinking: false,
  label: 'Researcher',
  system: 'ROLE:CHILD',
  tools: ['read_web', 'write_note'], // write_note is not `read`, so the child never gets it
  context: 'clean',
  finish: FINISH_TOOL,
  limits: { maxRounds: 3, maxToolCalls: 40 },
  task: () => ({ kind: 'ok', message: 'TASK' }),
  complete: async (output) => ({
    content: String((output as { answer?: unknown } | null)?.answer ?? ''),
    sources: [] as AgentSource[],
  }),
}

const KINDS: Record<string, ToolKind> = {
  read_web: 'web_search',
  write_note: 'edit_file',
  research: 'subagent',
}
const EFFECTS: Record<string, ToolEffect> = {
  read_web: 'read',
  write_note: 'artifact',
  research: 'spawn',
}

const env = createStoreEnv({
  kinds: KINDS,
  effects: EFFECTS,
  profiles: { research: PROFILE },
  params: { maxParallelReadCalls: MAX_PARALLEL, waitDefaultTimeoutS: 30 },
})

const delay = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms))
const isChild = (request: ApiRequest) => request.system.includes('ROLE:CHILD')

type ChildCall = { name: string; input: unknown }

/** A random mix of reads, board posts and a refused tool, with at least one long run of reads. */
const childCalls = (random: () => number): ChildCall[] => {
  const calls: ChildCall[] = []
  for (let i = 0; i < 14; i += 1) {
    const roll = random()
    if (roll < 0.65 || i < MAX_PARALLEL + 1) {
      calls.push({ name: 'read_web', input: { query: `q${i}` } })
    } else if (roll < 0.85) {
      calls.push({
        name: POST_TOOL_NAME,
        input: { kind: 'finding', text: `f${i}`, url: 'https://x.test' },
      })
    } else {
      calls.push({ name: 'write_note', input: { note: `n${i}` } })
    }
  }
  return calls
}

/** `[tool_use ids, tool_result ids]` in the order the child's second request carries them. */
const callAndResultOrder = (request: ApiRequest) => {
  const uses: string[] = []
  const results: string[] = []
  for (const message of request.messages) {
    if (!Array.isArray(message.content)) {
      continue
    }
    for (const part of message.content as { type: string; id?: string; tool_use_id?: string }[]) {
      if (part.type === 'tool_use' && part.id) {
        uses.push(part.id)
      } else if (part.type === 'tool_result' && part.tool_use_id) {
        results.push(part.tool_use_id)
      }
    }
  }
  return { uses, results }
}

describe("conversations store: a child's tool calls (SPEC invariant 20, concurrency)", () => {
  before(() => env.slice.commands.init())

  it('runs consecutive reads concurrently up to the cap, never across a post or refused call, and returns results in call order (randomized)', async () => {
    for (const seed of [1, 2, 3, 4, 5]) {
      const random = seeded(seed)
      const calls = childCalls(random)
      const childRequests: ApiRequest[] = []
      let leadStep = 0

      env.respondWith((request): ApiReply => {
        if (isChild(request)) {
          childRequests.push(request)
          return childRequests.length === 1
            ? { calls }
            : { calls: [{ name: FINISH_TOOL.name, input: { answer: 'done' } }] }
        }
        leadStep += 1
        return leadStep === 1
          ? {
              calls: [
                { name: 'research', input: {} },
                { name: WAIT_TOOL_NAME, input: { until: 'all' } },
              ],
            }
          : { text: 'all done' }
      })

      // Each read records when it ran; the clock is a counter so order, not time, is compared.
      let clock = 0
      let inFlight = 0
      let peak = 0
      const spans = new Map<number, { start: number; end: number }>()
      env.runToolsWith(async (call, context) => {
        assert.equal(context.caller.kind, 'agent', 'only the child runs tools here')
        assert.equal(call.name, 'read_web', 'the gateway never sees post or a refused tool')
        const index = Number(/q(\d+)/.exec(JSON.stringify(call.input))?.[1])
        const start = ++clock
        inFlight += 1
        peak = Math.max(peak, inFlight)
        await delay(1 + Math.floor(random() * 6))
        inFlight -= 1
        spans.set(index, { start, end: ++clock })
        return { content: `result q${index}`, status: 'ok' }
      })

      leadStep = 0
      env.slice.commands.newChat()
      env.slice.commands.setDraft(null, `research ${seed}`)
      assert.equal(env.slice.commands.send(null), true)
      await env.slice.commands.whenIdle()

      const reads = calls.flatMap((call, index) => (call.name === 'read_web' ? [index] : []))
      assert.equal(spans.size, reads.length, `seed ${seed}: every read ran once`)
      assert.ok(peak <= MAX_PARALLEL, `seed ${seed}: at most ${MAX_PARALLEL} reads at once`)

      // The longest run of consecutive reads is at least as long as the cap, so it must fill it.
      assert.equal(peak, MAX_PARALLEL, `seed ${seed}: a long run of reads fills the cap`)

      // A read after a post or refused call starts only after every read before that call ended.
      for (const later of reads) {
        const barrier = calls.findLastIndex((call, i) => i < later && call.name !== 'read_web')
        for (const earlier of reads.filter((index) => index < barrier)) {
          const a = spans.get(earlier)
          const b = spans.get(later)
          assert.ok(
            a && b && a.end < b.start,
            `seed ${seed}: read ${later} waited for read ${earlier}`
          )
        }
      }

      assert.equal(childRequests.length, 2, `seed ${seed}: one round of calls, then finish`)
      const { uses, results } = callAndResultOrder(childRequests[1])
      assert.equal(uses.length, calls.length)
      assert.deepEqual(results, uses, `seed ${seed}: results come back in call order`)
    }
  })
})
