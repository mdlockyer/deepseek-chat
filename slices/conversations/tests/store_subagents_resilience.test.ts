import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import {
  WAIT_TOOL_NAME,
  type AgentProfile,
  type AgentSource,
  type AssistantMessage,
  type ToolEffect,
  type ToolKind,
} from '@deepseek-chat/slice-conversations'
import { createStoreEnv, type ApiReply, type ApiRequest } from './store_harness.js'

// Review fixes for the subagent runtime: forced finish in thinking mode, results kept across Stop
// and Continue, child network retries, the automatic wait's timeout, and the stop reason after a
// lead error. The slice is created once per process, so these run in their own file and env.

const delay = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms))

const FINISH_TOOL = {
  name: 'finish_task',
  description: 'Return findings and sources',
  input_schema: {
    type: 'object',
    properties: { answer: { type: 'string' }, sources: { type: 'array' } },
    required: ['answer', 'sources'],
  },
}

const makeProfile = (thinking: boolean): AgentProfile => ({
  model: 'deepseek-flash',
  thinking,
  label: thinking ? 'Thinking researcher' : 'Plain researcher',
  system: thinking ? 'ROLE:THINK' : 'ROLE:PLAIN',
  tools: ['read_web'],
  context: 'clean',
  finish: FINISH_TOOL,
  limits: { maxRounds: 2, maxToolCalls: 6 },
  task: (input) => {
    const topic = input && typeof input === 'object' ? (input as { topic?: unknown }).topic : null
    return typeof topic === 'string' && topic.trim()
      ? { kind: 'ok', message: `TASK:${topic.trim()}` }
      : { kind: 'invalid', reason: 'topic is required' }
  },
  complete: async (output) => {
    const rec = output && typeof output === 'object' ? (output as Record<string, unknown>) : {}
    return {
      content: typeof rec.answer === 'string' ? rec.answer : String(output ?? ''),
      sources: Array.isArray(rec.sources) ? (rec.sources as AgentSource[]) : [],
    }
  },
})

const KINDS: Record<string, ToolKind> = {
  read_web: 'web_search',
  research_think: 'subagent',
  research_plain: 'subagent',
}
const EFFECTS: Record<string, ToolEffect> = {
  read_web: 'read',
  research_think: 'spawn',
  research_plain: 'spawn',
}

const env = createStoreEnv({
  kinds: KINDS,
  effects: EFFECTS,
  profiles: { research_think: makeProfile(true), research_plain: makeProfile(false) },
  params: { waitDefaultTimeoutS: 1, autoWaitTimeoutS: 30, toolRoundLimit: 10 },
})

const isLead = (req: ApiRequest) => !req.system.includes('ROLE:')
const topicOf = (req: ApiRequest) => /TASK:([^"\\]+)/.exec(JSON.stringify(req.messages))?.[1] ?? ''
const mentions = (req: ApiRequest, text: string) => JSON.stringify(req.messages).includes(text)

/** Text of the newest tool result the lead was sent (the latest `wait`, in these tests). */
const lastToolResult = (req: ApiRequest): string => {
  for (const message of [...req.messages].reverse()) {
    if (Array.isArray(message.content)) {
      const results = (message.content as { type?: string; content?: unknown }[]).filter(
        (part) => part.type === 'tool_result'
      )
      const last = results.at(-1)
      if (last) {
        return typeof last.content === 'string' ? last.content : JSON.stringify(last.content)
      }
    }
  }
  return ''
}

const lastReply = (): AssistantMessage => {
  const { activeId } = env.slice.getState()
  assert.ok(activeId)
  const reply = env.slice.getChatMessages(activeId).at(-1)
  return reply?.role === 'assistant' ? reply : assert.fail('last message is not a reply')
}

const send = (text: string) => {
  env.slice.commands.newChat()
  env.slice.commands.setDraft(null, text)
  assert.equal(env.slice.commands.send(null), true)
}

const blockUntilAborted = (signal?: AbortSignal) =>
  new Promise<ApiReply>((_resolve, reject) => {
    signal?.addEventListener('abort', () => reject(new DOMException('Aborted', 'AbortError')), {
      once: true,
    })
  })

/** Polls the active reply until `ready` holds, then returns its session id. */
const until = async (ready: (reply: AssistantMessage) => boolean): Promise<string> => {
  for (let i = 0; i < 400; i += 1) {
    const id = env.slice.getState().activeId
    const reply = id ? env.slice.getChatMessages(id).at(-1) : undefined
    if (id && reply?.role === 'assistant' && ready(reply)) {
      return id
    }
    await delay(5)
  }
  return assert.fail('reply never reached the expected state')
}

describe('subagent runtime review fixes', () => {
  it('never names tool_choice for a thinking child and keeps its work when the nudge fails or is ignored', async () => {
    await env.slice.commands.init()
    let namedChoiceWithThinking = 0
    const nudges: ApiRequest[] = []
    let leadFinal: ApiRequest | undefined
    let leadStep = 0
    env.respondWith(async (req) => {
      if (isLead(req)) {
        leadStep += 1
        if (leadStep === 1) {
          return {
            calls: [
              { name: 'research_think', input: { topic: 'prose-only' } },
              { name: 'research_think', input: { topic: 'limit-then-finish' } },
              { name: 'research_think', input: { topic: 'nudge-fails' } },
              { name: WAIT_TOOL_NAME, input: { until: 'all' } },
            ],
          }
        }
        leadFinal = req
        return { text: 'done' }
      }
      // DeepSeek's documented behaviour: a named tool_choice is a 400 in thinking mode.
      if (req.thinking?.type === 'enabled' && req.tool_choice?.type === 'tool') {
        namedChoiceWithThinking += 1
        return { errorStatus: 400, errorMessage: 'tool_choice is not supported in thinking mode' }
      }
      const isNudge = mentions(req, 'You ended your turn') || mentions(req, 'You have reached')
      if (isNudge) {
        nudges.push(req)
      }
      switch (topicOf(req)) {
        case 'prose-only':
          return { text: 'PROSE-ONLY-ANSWER' }
        case 'limit-then-finish':
          return isNudge
            ? {
                calls: [
                  {
                    name: 'finish_task',
                    input: {
                      answer: 'LIMIT-ANSWER [1]',
                      sources: [
                        {
                          n: 1,
                          url: 'https://example.com/a',
                          title: 'A',
                          verification: 'verified',
                        },
                      ],
                    },
                  },
                ],
              }
            : { calls: [{ name: 'read_web', input: { query: 'more' } }] }
        default:
          return isNudge
            ? { errorStatus: 500, errorMessage: 'nudge exploded' }
            : { text: 'NUDGE-FAILS-ANSWER' }
      }
    })
    env.runToolsWith(async () => ({ content: 'data', status: 'ok' }))

    send('thinking forced finish')
    await env.slice.commands.whenIdle()

    assert.equal(namedChoiceWithThinking, 0, 'no thinking request named a tool_choice')
    assert.equal(nudges.length, 3, 'each child got exactly one nudge')
    assert.ok(nudges.every((req) => req.tool_choice === undefined))
    const states = (lastReply().agents ?? []).map((agent) => agent.state)
    assert.deepEqual(
      states.map((state) => (state.status === 'exhausted' ? state.limit : state.status)),
      ['noFinishCall', 'rounds', 'noFinishCall']
    )
    assert.ok(leadFinal)
    assert.ok(mentions(leadFinal, 'PROSE-ONLY-ANSWER'), 'ignored nudge delivers the last text')
    assert.ok(mentions(leadFinal, 'LIMIT-ANSWER [citation:1]'), 'finish after nudge keeps sources')
    assert.ok(mentions(leadFinal, 'NUDGE-FAILS-ANSWER'), 'failed nudge delivers the last text')
    assert.ok(mentions(leadFinal, 'nudge exploded'), "the failed request's error reaches the lead")
  })

  it('delivers a result that finished during an aborted wait when the reply is continued, even if a board digest named the child', async () => {
    let leadStep = 0
    let releasePoster!: () => void
    const posterMayFinish = new Promise<void>((resolve) => {
      releasePoster = resolve
    })
    let firstWaitResult = ''
    let resumedFinal: ApiRequest | undefined
    env.respondWith(async (req, signal) => {
      if (isLead(req)) {
        leadStep += 1
        if (leadStep === 1) {
          return {
            calls: [
              { name: 'research_plain', input: { topic: 'poster' } },
              { name: 'research_plain', input: { topic: 'slow' } },
              { name: WAIT_TOOL_NAME, input: { until: 'any' } },
            ],
          }
        }
        if (leadStep === 2) {
          firstWaitResult = JSON.stringify(req.messages)
          releasePoster()
          return { calls: [{ name: WAIT_TOOL_NAME, input: { until: 'all' } }] }
        }
        if (leadStep === 3) {
          // First request after Continue.
          return { calls: [{ name: WAIT_TOOL_NAME, input: { until: 'all' } }] }
        }
        resumedFinal = req
        return { text: 'resumed' }
      }
      if (topicOf(req) === 'slow') {
        return blockUntilAborted(signal)
      }
      if (!mentions(req, 'Posted question')) {
        return {
          calls: [
            {
              name: 'post',
              input: { kind: 'question', question: 'Which region?', assumption: 'EU' },
            },
          ],
        }
      }
      await posterMayFinish
      return {
        calls: [{ name: 'finish_task', input: { answer: 'POSTER-RESULT', sources: [] } }],
      }
    })

    send('stop mid-wait then continue')
    const sessionId = await until(
      (reply) =>
        reply.agents?.[0]?.state.status === 'finished' &&
        reply.agents[1]?.state.status === 'running'
    )
    env.slice.stopReply(sessionId)
    await env.slice.commands.whenIdle()

    const stopped = lastReply()
    const posterRunId = stopped.agents?.[0]?.runId ?? ''
    assert.ok(firstWaitResult.includes(`question from ${posterRunId}`), 'digest named the poster')
    const posterState = stopped.agents?.[0]?.state
    assert.equal(
      posterState?.status === 'finished' ? posterState.result.content : undefined,
      'POSTER-RESULT',
      'result saved on the run'
    )
    const slowRunId = stopped.agents?.[1]?.runId ?? ''

    env.slice.commands.continueReply(sessionId, stopped.id)
    await env.slice.commands.whenIdle()

    // The resumed wait's own result must carry both ended children (SPEC: every ended child whose
    // result no earlier ok wait carried).
    assert.ok(resumedFinal)
    const resumedWait = lastToolResult(resumedFinal)
    assert.ok(resumedWait.includes('POSTER-RESULT'), 'uncollected result delivered on resume')
    assert.ok(resumedWait.includes(posterRunId) && resumedWait.includes(slowRunId))
    assert.equal(lastReply().status, 'done')
  })

  it('retries a child request that failed before any content, and accepts a stream cut after its stop reason', async () => {
    let leadStep = 0
    let flakyRequests = 0
    env.respondWith(async (req) => {
      if (isLead(req)) {
        leadStep += 1
        return leadStep === 1
          ? {
              calls: [
                { name: 'research_plain', input: { topic: 'flaky' } },
                { name: 'research_plain', input: { topic: 'cut' } },
                { name: WAIT_TOOL_NAME, input: { until: 'all' } },
              ],
            }
          : { text: 'done' }
      }
      if (topicOf(req) === 'flaky') {
        flakyRequests += 1
        return flakyRequests === 1
          ? { networkError: 'The network connection was lost.' }
          : { calls: [{ name: 'finish_task', input: { answer: 'RECOVERED', sources: [] } }] }
      }
      return {
        calls: [{ name: 'finish_task', input: { answer: 'CUT-BUT-WHOLE', sources: [] } }],
        dropMessageStop: true,
      }
    })

    send('flaky children')
    await env.slice.commands.whenIdle()

    assert.equal(flakyRequests, 2, 'one retry after the network error')
    const agents = lastReply().agents ?? []
    assert.deepEqual(
      agents.map((agent) => (agent.state.status === 'finished' ? agent.state.result.content : '')),
      ['RECOVERED', 'CUT-BUT-WHOLE']
    )
  })

  it("the app's own wait outlasts the model's default wait timeout", async () => {
    const leadRequests: ApiRequest[] = []
    env.respondWith(async (req) => {
      if (isLead(req)) {
        leadRequests.push(req)
        return leadRequests.length === 1
          ? { calls: [{ name: 'research_plain', input: { topic: 'takes-a-while' } }] }
          : { text: `lead turn ${leadRequests.length}` }
      }
      // Longer than waitDefaultTimeoutS (1 s), far shorter than autoWaitTimeoutS (30 s).
      await delay(1500)
      return { calls: [{ name: 'finish_task', input: { answer: 'SLOW-RESULT', sources: [] } }] }
    })

    send('end turn early')
    await env.slice.commands.whenIdle()

    assert.equal(leadRequests.length, 3, 'spawn, early end of turn, then the collected result')
    const final = leadRequests[2]
    assert.ok(final && lastToolResult(final).includes('SLOW-RESULT'))
  })

  it('stops running children as interrupted, not roundLimit, when the lead request fails', async () => {
    let leadStep = 0
    env.respondWith(async (req, signal) => {
      if (isLead(req)) {
        leadStep += 1
        return leadStep === 1
          ? { calls: [{ name: 'research_plain', input: { topic: 'orphan' } }] }
          : { errorStatus: 500, errorMessage: 'lead boom' }
      }
      return blockUntilAborted(signal)
    })

    send('lead fails')
    await env.slice.commands.whenIdle()

    const reply = lastReply()
    assert.equal(reply.status, 'error')
    assert.deepEqual(reply.agents?.[0]?.state, { status: 'stopped', reason: 'interrupted' })
  })
})
