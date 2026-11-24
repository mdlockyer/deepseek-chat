import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import {
  POST_TOOL_NAME,
  WAIT_TOOL_NAME,
  buildReplyView,
  needsWorkingIndicator,
  toLocalSession,
  toSessionFile,
  type AgentProfile,
  type AgentSource,
  type AssistantMessage,
  type Session,
  type ToolEffect,
  type ToolKind,
} from '@deepseek-chat/slice-conversations'
import { createStoreEnv, seeded, type ApiRequest } from './store_harness.js'

const delay = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms))

const FINISH_TOOL = {
  name: 'finish_task',
  description: 'Return findings and sources',
  input_schema: {
    type: 'object',
    properties: {
      answer: { type: 'string' },
      sources: { type: 'array' },
    },
    required: ['answer', 'sources'],
  },
}

const makeProfile = (context: 'clean' | 'fork', maxRounds = 2, maxToolCalls = 6): AgentProfile => ({
  model: 'deepseek-flash',
  thinking: false,
  label: context === 'clean' ? 'Clean Researcher' : 'Fork Reviewer',
  system: `ROLE:${context.toUpperCase()}`,
  tools: ['read_web', 'write_file', 'spawn_clean'], // includes forbidden tools to verify runtime allow-list
  context,
  finish: FINISH_TOOL,
  limits: { maxRounds, maxToolCalls },
  task: (input) => {
    const obj = input && typeof input === 'object' ? (input as { topic?: unknown }) : null
    if (typeof obj?.topic !== 'string' || !obj.topic.trim()) {
      return { kind: 'invalid', reason: 'topic is required' }
    }
    return { kind: 'ok', message: `TASK:${obj.topic.trim()}` }
  },
  complete: async (output) => {
    const rec =
      output && typeof output === 'object'
        ? (output as { answer?: unknown; sources?: unknown })
        : {}
    const answer = typeof rec.answer === 'string' ? rec.answer : String(output ?? '')
    const sources = Array.isArray(rec.sources) ? (rec.sources as AgentSource[]) : []
    return { content: answer, sources }
  },
})

const KINDS: Record<string, ToolKind> = {
  read_web: 'web_search',
  write_file: 'present_file',
  spawn_clean: 'subagent',
  spawn_fork: 'subagent',
}

const EFFECTS: Record<string, ToolEffect> = {
  read_web: 'read',
  write_file: 'artifact',
  spawn_clean: 'spawn',
  spawn_fork: 'spawn',
}

const PROFILES: Record<string, AgentProfile> = {
  spawn_clean: makeProfile('clean', 2, 6),
  spawn_fork: makeProfile('fork', 2, 6),
}

const MAX_RUNNING = 2
const MAX_PER_REPLY = 4
const MAX_POSTS = 2
const MAX_POST_CHARS = 80
const TOOL_ROUND_LIMIT = 5

const env = createStoreEnv({
  kinds: KINDS,
  effects: EFFECTS,
  profiles: PROFILES,
  params: {
    maxRunningChildren: MAX_RUNNING,
    maxChildrenPerReply: MAX_PER_REPLY,
    maxPostsPerChild: MAX_POSTS,
    maxPostChars: MAX_POST_CHARS,
    waitDefaultTimeoutS: 1,
    toolRoundLimit: TOOL_ROUND_LIMIT,
  },
})

const isLeadRequest = (req: ApiRequest) => !req.system.includes('ROLE:')

const extractChildTopic = (req: ApiRequest): string => {
  const text = JSON.stringify(req.messages)
  const match = /TASK:([^"\\]+)/.exec(text)
  return match?.[1] ?? 'unknown'
}

const extractRunId = (req: ApiRequest, index = 0): string => {
  const text = JSON.stringify(req.messages)
  const matches = [...text.matchAll(/agent-\d+-[a-z0-9_-]+/gi)]
  return matches[index]?.[0] ?? ''
}

const lastReply = (): AssistantMessage => {
  const { activeId } = env.slice.getState()
  assert.ok(activeId)
  const reply = env.slice.getChatMessages(activeId).at(-1)
  assert.equal(reply?.role, 'assistant')
  return reply.role === 'assistant' ? reply : assert.fail()
}

const turn = async (text: string) => {
  env.slice.commands.newChat()
  env.slice.commands.setDraft(null, text)
  assert.equal(env.slice.commands.send(null), true)
  await env.slice.commands.whenIdle()
}

describe('conversations subagent runtime (Phase 2 tests 2–19)', () => {
  it('auto-declares post & wait, spawns without waiting, isolates clean context, replays wait without child blocks, and round-trips archives (tests 2, 3, 7, 8)', async () => {
    await env.slice.commands.init()
    const leadSecret = 'LEAD-PRIVATE-USER-PROMPT-XYZ'
    let childFirstRequestSettled = false
    let spawnReturnedBeforeChildRequestEnded = false
    let leadStep = 0
    const childRequests: ApiRequest[] = []
    const leadRequests: ApiRequest[] = []

    env.respondWith(async (req) => {
      if (isLeadRequest(req)) {
        leadRequests.push(req)
        leadStep += 1
        if (leadStep === 1) {
          return {
            calls: [
              { name: 'spawn_clean', input: { topic: 'alpha', summary: 'Research alpha' } },
              { name: WAIT_TOOL_NAME, input: { until: 'all', summary: 'Wait for alpha' } },
            ],
          }
        }
        return { text: 'Lead final answer [citation:1].' }
      }
      childRequests.push(req)
      await delay(25)
      childFirstRequestSettled = true
      return {
        calls: [
          {
            name: 'finish_task',
            input: {
              answer: 'Alpha finding [1]',
              sources: [
                {
                  n: 1,
                  url: 'https://alpha.example',
                  title: 'Alpha Doc',
                  verification: 'verified',
                },
              ],
            },
          },
        ],
      }
    })

    env.runToolsWith(async () => ({ content: 'ok', status: 'ok' }))

    env.slice.commands.newChat()
    env.slice.commands.setDraft(null, leadSecret)
    env.slice.commands.send(null)
    // Poll briefly right after spawn to verify spawn returned while child's first request is in flight.
    for (let i = 0; i < 20; i += 1) {
      const id = env.slice.getState().activeId
      const msgs = id ? env.slice.getChatMessages(id) : []
      const reply = msgs.at(-1)
      if (reply?.role === 'assistant') {
        const spawnRes = reply.blocks.find((b) => b.type === 'tool_result' && b.status === 'ok')
        if (spawnRes && !childFirstRequestSettled) {
          spawnReturnedBeforeChildRequestEnded = true
          break
        }
      }
      await delay(2)
    }
    await env.slice.commands.whenIdle()

    assert.equal(
      spawnReturnedBeforeChildRequestEnded,
      true,
      'spawn returns before child first request ends'
    )

    // Rule 13: lead request automatically declares post & wait when a subagent tool is declared.
    const declaredNames = new Set(leadRequests[0]?.tools.map((t) => t.name))
    assert.ok(declaredNames.has(WAIT_TOOL_NAME))
    assert.ok(declaredNames.has(POST_TOOL_NAME))

    // Test 3: clean child never sees lead message text.
    assert.ok(childRequests.length >= 1)
    for (const creq of childRequests) {
      assert.ok(
        !JSON.stringify(creq).includes(leadSecret),
        'clean child must not contain lead prompt'
      )
    }

    // Test 7: lead's follow-up request carries wait result and never child's raw blocks.
    const secondLead = leadRequests[1]
    assert.ok(secondLead)
    const serializedLead = JSON.stringify(secondLead.messages)
    assert.ok(serializedLead.includes('Alpha finding [citation:1]'))
    assert.ok(!serializedLead.includes('finish_task'))

    // Test 8: archive round-trip preserves roles and text while omitting child transcripts.
    const reply = lastReply()
    assert.equal(reply.agents?.length, 1)
    assert.equal(reply.agents?.[0]?.state.status, 'finished')
    const session: Session = {
      id: 'arch-1',
      title: 'Archive Check',
      createdAt: 1_000,
      updatedAt: 2_000,
      messages: [
        { id: 'u1', role: 'user', content: leadSecret, files: [], createdAt: 1_000 },
        reply,
      ],
    }
    const archived = toSessionFile(session, () => null)
    const serializedArchive = JSON.stringify(archived)
    assert.ok(!serializedArchive.includes('finish_task'), 'child transcript omitted from archive')
    assert.ok(serializedArchive.includes('Alpha finding'), 'wait result text preserved in archive')
    const restored = toLocalSession(archived).session
    assert.deepEqual(
      restored.messages.map((m) => m.role),
      ['user', 'assistant']
    )
    assert.ok(
      restored.messages[1]?.role === 'assistant' &&
        restored.messages[1].blocks.some(
          (b) => b.type === 'text' && b.text.includes('Lead final answer')
        )
    )
  })

  it('enforces read-only allow-list and depth 1 without calling gateway for forbidden tools (test 4)', async () => {
    let leadStep = 0
    let childStep = 0
    const childToolRequests: ApiRequest[] = []
    const runsBefore = env.runs.length

    env.respondWith(async (req) => {
      if (isLeadRequest(req)) {
        leadStep += 1
        return leadStep === 1
          ? {
              calls: [
                { name: 'spawn_clean', input: { topic: 'security' } },
                { name: WAIT_TOOL_NAME, input: { until: 'all' } },
              ],
            }
          : { text: 'done' }
      }
      childToolRequests.push(req)
      childStep += 1
      if (childStep === 1) {
        return {
          calls: [
            { name: 'write_file', input: { path: 'evil.txt' } },
            { name: 'spawn_clean', input: { topic: 'nested' } },
            { name: 'read_web', input: { query: 'allowed' } },
          ],
        }
      }
      return { calls: [{ name: 'finish_task', input: { answer: 'checked', sources: [] } }] }
    })

    env.runToolsWith(async (_call, ctx) => {
      assert.equal(ctx.caller.kind, 'agent', 'tool sees agent caller provenance')
      return { content: 'web ok', status: 'ok' }
    })

    await turn('check allow-list')

    const newRuns = env.runs.slice(runsBefore)
    assert.deepEqual(
      newRuns.map((r) => r.call.name),
      ['read_web'],
      'gateway never ran forbidden write_file or nested spawn_clean'
    )
    // Child's tool schema list must not declare write_file or spawn_clean.
    const childDeclared = new Set(childToolRequests[0]?.tools.map((t) => t.name))
    assert.ok(childDeclared.has('read_web'))
    assert.ok(childDeclared.has(POST_TOOL_NAME))
    assert.ok(childDeclared.has('finish_task'))
    assert.ok(!childDeclared.has('write_file'))
    assert.ok(!childDeclared.has('spawn_clean'))
    // Second child request received error results for the forbidden calls.
    const secondChildMsg = JSON.stringify(childToolRequests[1]?.messages ?? [])
    assert.ok(secondChildMsg.includes('not allowed'))
  })

  it('ends a child exhausted after maxRounds + 1 forced-finish request and handles all four outcomes + no-finish forced call (tests 5, 18)', async () => {
    // Part A: child never calls finish -> maxRounds (2) + 1 forced-finish = 3 child requests -> exhausted.
    let leadStep = 0
    const childReqs: ApiRequest[] = []
    env.respondWith(async (req) => {
      if (isLeadRequest(req)) {
        leadStep += 1
        return leadStep === 1
          ? {
              calls: [
                { name: 'spawn_clean', input: { topic: 'endless' } },
                { name: WAIT_TOOL_NAME, input: { until: 'all' } },
              ],
            }
          : { text: 'done exhausted' }
      }
      childReqs.push(req)
      return { calls: [{ name: 'read_web', input: { query: `q-${childReqs.length}` } }] }
    })
    env.runToolsWith(async () => ({ content: 'data', status: 'ok' }))

    await turn('exhaust child')
    assert.equal(childReqs.length, 3, '2 rounds + 1 forced-finish request')
    assert.deepEqual(childReqs[2]?.tool_choice, { type: 'tool', name: 'finish_task' })
    const exhaustedReply = lastReply()
    assert.deepEqual(exhaustedReply.agents?.[0]?.state, { status: 'exhausted', limit: 'rounds' })

    // Part B: child ends turn with text only (no finish call) -> gets 1 forced-finish request -> finished ONLY if that call arrives.
    leadStep = 0
    const noFinishReqs: ApiRequest[] = []
    env.respondWith(async (req) => {
      if (isLeadRequest(req)) {
        leadStep += 1
        return leadStep === 1
          ? {
              calls: [
                { name: 'spawn_clean', input: { topic: 'text-only-then-finish' } },
                { name: 'spawn_clean', input: { topic: 'text-only-refuses-finish' } },
                { name: WAIT_TOOL_NAME, input: { until: 'all' } },
              ],
            }
          : { text: 'done outcomes' }
      }
      noFinishReqs.push(req)
      const topic = extractChildTopic(req)
      if (req.tool_choice?.name === 'finish_task') {
        if (topic === 'text-only-then-finish') {
          return { calls: [{ name: 'finish_task', input: { answer: 'ok now', sources: [] } }] }
        }
        return { text: 'still refused finish' }
      }
      return { text: 'plain text without finish' }
    })

    await turn('forced finish test')
    const agentsB = lastReply().agents ?? []
    assert.equal(agentsB[0]?.state.status, 'finished')
    assert.equal(agentsB[1]?.state.status, 'exhausted')

    // Part C: child HTTP 500 -> failed outcome reported on wait.
    leadStep = 0
    env.respondWith(async (req) => {
      if (isLeadRequest(req)) {
        leadStep += 1
        return leadStep === 1
          ? {
              calls: [
                { name: 'spawn_clean', input: { topic: 'boom' } },
                { name: WAIT_TOOL_NAME, input: { until: 'all' } },
              ],
            }
          : { text: 'handled failure' }
      }
      return { errorStatus: 500, errorMessage: 'Upstream boom' }
    })
    await turn('fail child')
    const failedAgent = lastReply().agents?.[0]
    assert.equal(failedAgent?.state.status, 'failed')
    if (failedAgent?.state.status === 'failed') {
      assert.equal(failedAgent.state.error.kind, 'http')
      assert.ok(failedAgent.state.error.message.includes('Upstream boom'))
    }
  })

  it('cascades stop to running children while keeping finished results and issuing no further requests (test 6)', async () => {
    let leadStep = 0
    let requestsAfterAbort = 0
    let aborted = false

    env.respondWith(async (req, signal) => {
      if (aborted) {
        requestsAfterAbort += 1
      }
      if (isLeadRequest(req)) {
        leadStep += 1
        if (leadStep === 1) {
          return {
            calls: [
              { name: 'spawn_clean', input: { topic: 'fast-done' } },
              { name: 'spawn_clean', input: { topic: 'slow-running' } },
              { name: WAIT_TOOL_NAME, input: { until: 'all' } },
            ],
          }
        }
        return { text: 'never reached' }
      }
      const topic = extractChildTopic(req)
      if (topic === 'fast-done') {
        return { calls: [{ name: 'finish_task', input: { answer: 'kept result', sources: [] } }] }
      }
      // Slow child waits until aborted.
      await new Promise<void>((_resolve, reject) => {
        signal?.addEventListener('abort', () => reject(new DOMException('Aborted', 'AbortError')), {
          once: true,
        })
      })
      return { text: 'never' }
    })

    env.slice.commands.newChat()
    env.slice.commands.setDraft(null, 'stop test')
    env.slice.commands.send(null)

    // Wait until fast child finishes and slow child is still running.
    for (let i = 0; i < 50; i += 1) {
      const id = env.slice.getState().activeId
      const reply = id ? env.slice.getChatMessages(id).at(-1) : undefined
      if (
        id &&
        reply?.role === 'assistant' &&
        reply.agents?.length === 2 &&
        reply.agents[0]?.state.status === 'finished' &&
        reply.agents[1]?.state.status === 'running'
      ) {
        aborted = true
        env.slice.stopReply(id)
        break
      }
      await delay(5)
    }
    await env.slice.commands.whenIdle()
    await delay(10)

    assert.equal(aborted, true)
    assert.equal(requestsAfterAbort, 0, 'no requests after abort')
    const stoppedReply = lastReply()
    assert.equal(stoppedReply.status, 'stopped')
    assert.equal(stoppedReply.agents?.[0]?.state.status, 'finished')
    assert.deepEqual(stoppedReply.agents?.[1]?.state, { status: 'stopped', reason: 'user' })
  })

  it('delivers board posts once in posting order never to author, does not block on questions, wakes wait on question/end/timeout never on finding alone, and enforces post caps (tests 9, 10, 11, 13)', async () => {
    let leadStep = 0
    const childSteps = new Map<string, number>()
    const seenByAgent = new Map<string, string[]>()
    let leadWakeCount = 0
    let questionPostedAndChildContinued = false
    let findingWakeOccurred = false

    env.respondWith(async (req) => {
      if (isLeadRequest(req)) {
        leadStep += 1
        if (leadStep === 1) {
          return {
            calls: [
              { name: 'spawn_clean', input: { topic: 'posterA' } },
              { name: 'spawn_clean', input: { topic: 'posterB' } },
              { name: WAIT_TOOL_NAME, input: { until: 'any', timeout_s: 2 } },
            ],
          }
        }
        if (leadStep === 2) {
          leadWakeCount += 1
          const msgJson = JSON.stringify(req.messages)
          // Woke on posterB's question (not on posterA's finding alone).
          assert.ok(msgJson.includes('Which year?'), 'wait woke on question')
          const runIdB = extractRunId(req, 1)
          return {
            calls: [
              {
                name: POST_TOOL_NAME,
                input: {
                  kind: 'direction',
                  to: { kind: 'agent', runId: runIdB },
                  text: 'Use 2026 data.',
                },
              },
              { name: WAIT_TOOL_NAME, input: { until: 'all', timeout_s: 2 } },
            ],
          }
        }
        if (leadStep === 3) {
          // Try directing an already-ended child -> must get error result.
          const endedRunId = extractRunId(req, 0)
          return {
            calls: [
              {
                name: POST_TOOL_NAME,
                input: {
                  kind: 'direction',
                  to: { kind: 'agent', runId: endedRunId },
                  text: 'Too late',
                },
              },
            ],
          }
        }
        const msgJson = JSON.stringify(req.messages)
        assert.ok(msgJson.includes('has already ended'), 'direction to ended child returns error')
        return { text: 'Board coordinated.' }
      }

      const topic = extractChildTopic(req)
      const step = (childSteps.get(topic) ?? 0) + 1
      childSteps.set(topic, step)

      // Record any board digest lines seen by this child.
      const serialized = JSON.stringify(req.messages)
      const lines = seenByAgent.get(topic) ?? []
      if (serialized.includes('On the board since your last step')) {
        lines.push(serialized)
        seenByAgent.set(topic, lines)
      }

      if (topic === 'posterA') {
        if (step === 1) {
          // Post 1 valid finding, 1 over-length finding (rejected), 1 valid finding (hits cap=2), 1 over-cap finding (rejected).
          return {
            calls: [
              {
                name: POST_TOOL_NAME,
                input: { kind: 'finding', text: 'Fact-A1', url: 'https://a.example/1' },
              },
              {
                name: POST_TOOL_NAME,
                input: {
                  kind: 'finding',
                  text: 'X'.repeat(MAX_POST_CHARS + 5),
                  url: 'https://a.example/long',
                },
              },
              {
                name: POST_TOOL_NAME,
                input: { kind: 'finding', text: 'Fact-A2', url: 'https://a.example/2' },
              },
              {
                name: POST_TOOL_NAME,
                input: { kind: 'finding', text: 'Fact-A3-over-cap', url: 'https://a.example/3' },
              },
            ],
          }
        }
        // Delay slightly so finding-only non-wakeup is observable, then wait for posterB's question.
        await delay(30)
        // Must NOT see its own posts Fact-A1 or Fact-A2 under "On the board since your last step"!
        const lastMsg = JSON.stringify(req.messages.at(-1))
        assert.ok(!lastMsg.includes('[untrusted finding from agent-1'), 'never sees own posts')
        assert.ok(lastMsg.includes('Post too long'), 'over-length post returned error')
        assert.ok(lastMsg.includes('Post cap reached'), 'over-cap post returned error')
        return { calls: [{ name: 'finish_task', input: { answer: 'A done', sources: [] } }] }
      }

      // posterB: wait briefly after posterA posts findings (confirming wait did NOT wake on findings alone)
      if (step === 1) {
        await delay(15)
        if (leadWakeCount > 0) {
          findingWakeOccurred = true
        }
        return {
          calls: [
            {
              name: POST_TOOL_NAME,
              input: {
                kind: 'question',
                question: 'Which year?',
                assumption: 'Assuming 2025',
              },
            },
          ],
        }
      }
      // Step 2: posterB immediately runs its next request without blocking for lead's answer (test 10)!
      questionPostedAndChildContinued = true
      const lastMsg = JSON.stringify(req.messages.at(-1))
      assert.ok(
        lastMsg.includes('Fact-A1') && lastMsg.includes('Fact-A2'),
        'posterB sees A findings in order'
      )
      assert.ok(
        lastMsg.indexOf('Fact-A1') < lastMsg.indexOf('Fact-A2'),
        'board posts arrive in posting order'
      )
      return { calls: [{ name: 'finish_task', input: { answer: 'B done', sources: [] } }] }
    })

    await turn('board test')
    assert.equal(findingWakeOccurred, false, 'finding alone never wakes wait')
    assert.equal(
      questionPostedAndChildContinued,
      true,
      'child posting question continues without blocking'
    )
    const board = lastReply().board ?? []
    assert.ok(!board.some((p) => p.kind === 'finding' && p.text.includes('over-cap')))
    assert.ok(!board.some((p) => p.kind === 'finding' && p.text.length > MAX_POST_CHARS))
  })

  it('auto-waits when lead ends turn with running children (test 12) and numbers citations across random finish orders (test 14)', async () => {
    const rand = seeded(42)
    let leadStep = 0
    env.respondWith(async (req) => {
      if (isLeadRequest(req)) {
        leadStep += 1
        if (leadStep === 1) {
          // Lead first runs a direct search (source #1), then spawns 2 children and forgets to call wait!
          return {
            calls: [
              { name: 'read_web', input: { query: 'direct' } },
              { name: 'spawn_clean', input: { topic: 'c1' } },
              { name: 'spawn_clean', input: { topic: 'c2' } },
            ],
          }
        }
        if (leadStep === 2) {
          // Lead tries to end turn while children are still running -> runtime must auto-wait!
          return { text: 'Premature finish' }
        }
        return { text: 'Final synthesis [citation:1] [citation:2] [citation:3].' }
      }
      const topic = extractChildTopic(req)
      await delay(10 + Math.floor(rand() * 25))
      if (topic === 'c1') {
        return {
          calls: [
            {
              name: 'finish_task',
              input: {
                answer: 'Child 1 cites [1] and [2].',
                sources: [
                  {
                    n: 1,
                    url: 'https://direct.example',
                    title: 'Direct',
                    verification: 'verified',
                  },
                  { n: 2, url: 'https://c1.example', title: 'C1 Src', verification: 'verified' },
                ],
              },
            },
          ],
        }
      }
      return {
        calls: [
          {
            name: 'finish_task',
            input: {
              answer: 'Child 2 cites [1].',
              sources: [
                { n: 1, url: 'https://c2.example', title: 'C2 Src', verification: 'unverified' },
              ],
            },
          },
        ],
      }
    })

    env.runToolsWith(async () => ({
      content: 'Direct search [1]',
      status: 'ok',
      searchResults: [
        {
          url: 'https://direct.example',
          title: 'Direct',
          snippet: 's',
          siteName: 'direct.example',
          publishedAt: null,
        },
      ],
    }))

    await turn('no orphan + citations')
    const reply = lastReply()
    assert.equal(reply.status, 'done')
    assert.ok(reply.agents?.every((a) => a.state.status === 'finished'))
    // Verify citation numbers have no gaps and match view.sources!
    const view = buildReplyView(reply, false)
    assert.deepEqual(
      view.sources.map((s) => s.index),
      [1, 2, 3]
    )
    const urls = new Set(view.sources.map((s) => s.url))
    assert.deepEqual(
      urls,
      new Set(['https://direct.example', 'https://c1.example', 'https://c2.example'])
    )
    assert.ok(view.steps.some((s) => s.type === 'agent'))
    assert.ok(view.steps.some((s) => s.type === 'wait'))
    assert.equal(needsWorkingIndicator(view), true)
  })

  it('enforces running cap and per-reply cap on spawn (test 17) and round limit stops children with roundLimit (test 16)', async () => {
    // Test 17: running cap (2) and per-reply cap (4).
    let leadStep = 0
    const leadMsgs: string[] = []
    env.respondWith(async (req) => {
      if (isLeadRequest(req)) {
        leadStep += 1
        leadMsgs.push(JSON.stringify(req.messages))
        if (leadStep === 1) {
          // Try spawning 3 at once when maxRunningChildren = 2 -> 3rd must get error naming cap.
          return {
            calls: [
              { name: 'spawn_clean', input: { topic: 'r1' } },
              { name: 'spawn_clean', input: { topic: 'r2' } },
              { name: 'spawn_clean', input: { topic: 'r3-over-running' } },
              { name: WAIT_TOOL_NAME, input: { until: 'all' } },
            ],
          }
        }
        if (leadStep === 2) {
          // Spawn 2 more (total 4 = maxChildrenPerReply), wait, then try a 5th.
          return {
            calls: [
              { name: 'spawn_clean', input: { topic: 'r3' } },
              { name: 'spawn_clean', input: { topic: 'r4' } },
              { name: WAIT_TOOL_NAME, input: { until: 'all' } },
            ],
          }
        }
        if (leadStep === 3) {
          return {
            calls: [{ name: 'spawn_clean', input: { topic: 'r5-over-reply' } }],
          }
        }
        return { text: 'caps verified' }
      }
      await delay(10)
      return { calls: [{ name: 'finish_task', input: { answer: 'ok', sources: [] } }] }
    })

    await turn('caps test')
    assert.ok(leadMsgs[1]?.includes('maxRunningChildren'), 'running cap error reported')
    assert.ok(leadMsgs[3]?.includes('maxChildrenPerReply'), 'per-reply cap error reported')
    assert.equal(lastReply().agents?.length, MAX_PER_REPLY)

    // Test 16: round limit wins when lead keeps calling wait while a child runs.
    let waitRound = 0
    env.respondWith(async (req, signal) => {
      if (isLeadRequest(req)) {
        waitRound += 1
        if (waitRound === 1) {
          return {
            calls: [
              { name: 'spawn_clean', input: { topic: 'finished-one' } },
              { name: 'spawn_clean', input: { topic: 'forever-one' } },
              { name: WAIT_TOOL_NAME, input: { until: 'any', timeout_s: 0.01 } },
            ],
          }
        }
        return {
          calls: [{ name: WAIT_TOOL_NAME, input: { until: 'any', timeout_s: 0.01 } }],
        }
      }
      const topic = extractChildTopic(req)
      if (topic === 'finished-one') {
        return { calls: [{ name: 'finish_task', input: { answer: 'finished', sources: [] } }] }
      }
      await new Promise<void>((_resolve, reject) => {
        signal?.addEventListener('abort', () => reject(new DOMException('Aborted', 'AbortError')), {
          once: true,
        })
      })
      return { text: 'never' }
    })

    await turn('round limit test')
    const limitedReply = lastReply()
    assert.equal(limitedReply.status, 'error')
    assert.equal(limitedReply.agents?.[0]?.state.status, 'finished')
    assert.deepEqual(limitedReply.agents?.[1]?.state, { status: 'stopped', reason: 'roundLimit' })
  })

  it('gives fork children lead messages up to the spawn call and nothing after it (test 19)', async () => {
    const leadPriorText = 'CONTEXT-BEFORE-SPAWN-777'
    let leadStep = 0
    const forkRequests: ApiRequest[] = []

    env.respondWith(async (req) => {
      if (isLeadRequest(req)) {
        leadStep += 1
        if (leadStep === 1) {
          return {
            calls: [
              { name: 'spawn_fork', input: { topic: 'review-now' } },
              { name: 'read_web', input: { query: 'AFTER-SPAWN-MARKER-999' } },
              { name: WAIT_TOOL_NAME, input: { until: 'all' } },
            ],
          }
        }
        return { text: 'fork complete' }
      }
      forkRequests.push(req)
      return { calls: [{ name: 'finish_task', input: { answer: 'reviewed', sources: [] } }] }
    })
    env.runToolsWith(async () => ({ content: 'AFTER-SPAWN-RESULT-999', status: 'ok' }))

    await turn(leadPriorText)
    assert.equal(forkRequests.length, 1)
    const serialized = JSON.stringify(forkRequests[0]?.messages)
    assert.ok(serialized.includes(leadPriorText), 'fork child receives prior lead message')
    assert.ok(serialized.includes('TASK:review-now'), 'fork child receives its task message')
    assert.ok(!serialized.includes('AFTER-SPAWN-MARKER-999'), 'fork child sees nothing after spawn')
    assert.ok(
      !serialized.includes('AFTER-SPAWN-RESULT-999'),
      'fork child sees no later tool results'
    )
  })

  it('recovers interrupted running children on reload and returns them immediately on first wait (test 15)', async () => {
    let leadStep = 0
    let resumedWaitSawStopped = false

    env.respondWith(async (req, signal) => {
      if (isLeadRequest(req)) {
        leadStep += 1
        if (leadStep === 1) {
          return {
            calls: [
              { name: 'spawn_clean', input: { topic: 'will-interrupt' } },
              { name: WAIT_TOOL_NAME, input: { until: 'all' } },
            ],
          }
        }
        if (leadStep === 2) {
          return {
            calls: [{ name: WAIT_TOOL_NAME, input: { until: 'all' } }],
          }
        }
        const serialized = JSON.stringify(req.messages)
        if (serialized.includes('stopped')) {
          resumedWaitSawStopped = true
        }
        return { text: 'Recovered after resume.' }
      }
      await new Promise<void>((_resolve, reject) => {
        signal?.addEventListener('abort', () => reject(new DOMException('Aborted', 'AbortError')), {
          once: true,
        })
      })
      return { text: 'never' }
    })

    env.slice.commands.newChat()
    env.slice.commands.setDraft(null, 'interrupt and continue')
    env.slice.commands.send(null)

    let sessionId = ''
    for (let i = 0; i < 40; i += 1) {
      const id = env.slice.getState().activeId
      const reply = id ? env.slice.getChatMessages(id).at(-1) : undefined
      if (id && reply?.role === 'assistant' && reply.agents?.[0]?.state.status === 'running') {
        sessionId = id
        env.slice.stopReply(sessionId)
        break
      }
      await delay(5)
    }
    await env.slice.commands.whenIdle()

    const stopped = lastReply()
    assert.equal(stopped.status, 'stopped')
    assert.equal(stopped.agents?.[0]?.state.status, 'stopped')

    // Continue the stopped reply: lead's first wait returns the stopped child at once and never hangs!
    env.slice.commands.continueReply(sessionId, stopped.id)
    await env.slice.commands.whenIdle()
    assert.equal(resumedWaitSawStopped, true, 'continued reply received stopped child immediately')
    assert.equal(lastReply().status, 'done')

    // Part B: simulate a hard reload where IndexedDB holds a `running` child and a `finished` child.
    const dbReq = indexedDB.open('chat-demo')
    const idb = await new Promise<IDBDatabase>((resolve, reject) => {
      dbReq.onsuccess = () => resolve(dbReq.result)
      dbReq.onerror = () => reject(dbReq.error)
    })
    const tx = idb.transaction('sessions', 'readwrite')
    const storeObj = tx.objectStore('sessions')
    const stored = await new Promise<Session>((resolve, reject) => {
      const getReq = storeObj.get(sessionId)
      getReq.onsuccess = () => resolve(getReq.result as Session)
      getReq.onerror = () => reject(getReq.error)
    })
    const patched: Session = {
      ...stored,
      messages: stored.messages.map((m) =>
        m.role === 'assistant'
          ? {
              ...m,
              status: 'streaming',
              agents: [
                {
                  runId: 'agent-finished-1',
                  profile: 'spawn_clean',
                  startedBy: 'call-fin',
                  state: { status: 'finished' },
                  blocks: [],
                },
                {
                  runId: 'agent-crashed-2',
                  profile: 'spawn_clean',
                  startedBy: 'call-crash',
                  state: { status: 'running', round: 2 },
                  blocks: [],
                },
              ],
            }
          : m
      ),
    }
    await new Promise<void>((resolve, reject) => {
      const putReq = storeObj.put(patched)
      putReq.onsuccess = () => resolve()
      putReq.onerror = () => reject(putReq.error)
    })
    idb.close()

    // Evict `sessionId` from the 5-entry in-memory cache by creating 6 quick chats.
    env.respondWith(() => ({ text: 'evict' }))
    for (let k = 0; k < 6; k += 1) {
      await turn(`evict-${k}`)
    }

    // Re-select `sessionId` so it reloads from IndexedDB and runs settleInterrupted.
    env.slice.commands.selectSession(sessionId)
    for (let i = 0; i < 40; i += 1) {
      if (env.slice.getChatMessages(sessionId).length > 0) {
        break
      }
      await delay(5)
    }
    const reloaded = env.slice.getChatMessages(sessionId).at(-1)
    assert.equal(reloaded?.role, 'assistant')
    if (reloaded?.role === 'assistant') {
      assert.equal(reloaded.status, 'stopped')
      assert.equal(reloaded.agents?.[0]?.state.status, 'finished')
      assert.deepEqual(reloaded.agents?.[1]?.state, { status: 'stopped', reason: 'interrupted' })

      // Continuing this reloaded reply makes the first wait report `agent-crashed-2` interrupted at once!
      let sawInterruptedOnWait = false
      let resumeStep = 0
      env.respondWith(async (req) => {
        resumeStep += 1
        if (resumeStep === 1) {
          return { calls: [{ name: WAIT_TOOL_NAME, input: { until: 'all' } }] }
        }
        const msg = JSON.stringify(req.messages)
        if (msg.includes('agent-crashed-2') && msg.includes('interrupted')) {
          sawInterruptedOnWait = true
        }
        return { text: 'Resumed after crash.' }
      })
      env.slice.commands.continueReply(sessionId, reloaded.id)
      await env.slice.commands.whenIdle()
      assert.equal(
        sawInterruptedOnWait,
        true,
        'first wait after reload reported interrupted child immediately'
      )
    }
  })
})
