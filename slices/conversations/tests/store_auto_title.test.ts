import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { createStoreEnv, say, type ApiReply, type ApiRequest } from './store_harness.js'

const env = createStoreEnv({
  toolNames: ['run_code', 'find_web'],
  effects: { run_code: 'session', find_web: 'read' },
  instructions: (names) =>
    [...names]
      .sort()
      .map((n) => `## Tool ${n}`)
      .join('\n\n'),
  autoTitle: true,
})

const flushAsync = async () => {
  for (let i = 0; i < 12; i += 1) {
    await new Promise((resolve) => setTimeout(resolve, 0))
  }
}

const isAutoTitleRequest = (req: ApiRequest) => {
  const last = req.messages.at(-1)
  return (
    last?.role === 'user' &&
    typeof last.content === 'string' &&
    last.content.includes('Do not call any tools.')
  )
}

describe('conversations store: cache-riding turn-end auto-title hook (SPEC invariant 10)', () => {
  it('cleans quotes, markdown, CJK punctuation, multi-line text, KEEP variants, and oversized titles at the boundary', async () => {
    await env.slice.commands.init()
    const cases: { forkText: string; expectedTitle: string }[] = [
      { forkText: '# "Q4 Revenue Analysis."', expectedTitle: 'Q4 Revenue Analysis' },
      { forkText: '  "keep."  ', expectedTitle: 'Q4 Revenue Analysis' },
      { forkText: '   \n  ', expectedTitle: 'Q4 Revenue Analysis' },
      { forkText: '- 「深度思考缓存设计」：', expectedTitle: '深度思考缓存设计' },
      { forkText: 'First Line\nIgnored Second', expectedTitle: 'First Line' },
    ]
    let step = 0
    env.respondWith((req): ApiReply => {
      if (isAutoTitleRequest(req)) {
        const next = cases[step]
        step += 1
        return { text: next ? next.forkText : 'A'.repeat(120) }
      }
      return { text: 'ok' }
    })

    env.slice.commands.newChat()
    await say(env, null, 'Turn 0')
    await flushAsync()
    const sessionId = env.slice.getState().activeId
    assert.ok(sessionId)
    assert.equal(
      env.slice.getState().sessions.find((s) => s.id === sessionId)?.title,
      cases[0]?.expectedTitle
    )

    for (let i = 1; i < cases.length; i += 1) {
      await say(env, sessionId, `Turn ${i}`)
      await flushAsync()
      assert.equal(
        env.slice.getState().sessions.find((s) => s.id === sessionId)?.title,
        cases[i]?.expectedTitle,
        `case ${i} (${JSON.stringify(cases[i]?.forkText)})`
      )
    }

    // Oversized title is capped cleanly below raw 120-character input.
    await say(env, sessionId, 'Turn overflow')
    await flushAsync()
    const capped = env.slice.getState().sessions.find((s) => s.id === sessionId)?.title ?? ''
    assert.ok(capped.length > 0 && capped.length < 120 && /^A+$/.test(capped), `got "${capped}"`)
  })
  it('names the chat via the cache-riding fork on turn 1 and refreshes on turn 2 with an identical prefix', async () => {
    await env.slice.commands.init()
    env.slice.commands.newChat()
    const before = env.requests.length
    let forkNumber = 0

    env.respondWith((req): ApiReply => {
      if (isAutoTitleRequest(req)) {
        forkNumber += 1
        return { text: forkNumber === 1 ? 'Quick Intro' : 'Q4 Cohort Analysis' }
      }
      if (req.messages.filter((m) => m.role === 'user').length === 1) {
        return { text: 'Here is a quick intro.' }
      }
      return { text: 'Here is the full Q4 cohort breakdown.' }
    })

    await say(env, null, 'Hello')
    await flushAsync()
    const sessionId = env.slice.getState().activeId
    assert.ok(sessionId)

    // Turn 1 uses the standard cache-riding fork (never a proprietary `title` request param).
    assert.equal(env.requests.length, before + 2)
    const turn1Main = env.requests[before]
    const turn1Fork = env.requests[before + 1]
    assert.ok(turn1Main && turn1Fork)
    assert.equal('title' in turn1Main, false)
    assert.equal('safety_check' in turn1Main, false)
    assert.ok(isAutoTitleRequest(turn1Fork))
    assert.equal(turn1Fork.system, turn1Main.system)
    assert.deepEqual(turn1Fork.tools, turn1Main.tools)
    assert.deepEqual(turn1Fork.messages.slice(0, turn1Main.messages.length), turn1Main.messages)
    assert.equal(
      env.slice.getState().sessions.find((s) => s.id === sessionId)?.title,
      'Quick Intro'
    )
    const updatedAfterTurn1 = env.slice
      .getState()
      .sessions.find((s) => s.id === sessionId)?.updatedAt

    await say(env, sessionId, 'Actually let us do a Q4 revenue cohort analysis.')
    const updatedAfterTurn2 = env.slice
      .getState()
      .sessions.find((s) => s.id === sessionId)?.updatedAt
    await flushAsync()

    const turn2Main = env.requests[before + 2]
    const turn2Fork = env.requests[before + 3]
    assert.ok(turn2Main && turn2Fork)
    assert.ok(isAutoTitleRequest(turn2Fork))

    assert.equal(turn2Fork.system, turn2Main.system)
    assert.deepEqual(turn2Fork.tools, turn2Main.tools)
    assert.deepEqual(turn2Fork.messages.slice(0, turn2Main.messages.length), turn2Main.messages)
    assert.equal(turn2Fork.messages[turn2Main.messages.length]?.role, 'assistant')
    assert.equal(turn2Fork.messages.length, turn2Main.messages.length + 2)

    const summary = env.slice.getState().sessions.find((s) => s.id === sessionId)
    assert.equal(summary?.title, 'Q4 Cohort Analysis')
    assert.equal(summary?.updatedAt, updatedAfterTurn2)
    assert.ok((updatedAfterTurn2 ?? 0) >= (updatedAfterTurn1 ?? 0))
    assert.equal(env.slice.getChatMessages(sessionId).length, 4)
  })

  it('keeps the current title when the model answers KEEP', async () => {
    env.slice.commands.newChat()
    let forkNumber = 0
    env.respondWith((req): ApiReply => {
      if (isAutoTitleRequest(req)) {
        forkNumber += 1
        return { text: forkNumber === 1 ? 'Stable Topic' : 'KEEP' }
      }
      return { text: 'ok' }
    })

    await say(env, null, 'Start stable topic')
    await flushAsync()
    const sessionId = env.slice.getState().activeId
    assert.ok(sessionId)
    assert.equal(
      env.slice.getState().sessions.find((s) => s.id === sessionId)?.title,
      'Stable Topic'
    )

    await say(env, sessionId, 'Tiny formatting tweak')
    await flushAsync()

    assert.equal(
      env.slice.getState().sessions.find((s) => s.id === sessionId)?.title,
      'Stable Topic'
    )
  })

  it('locks the title on manual rename and unlocks when cleared to blank', async () => {
    env.slice.commands.newChat()
    let forkCount = 0
    env.respondWith((req): ApiReply => {
      if (isAutoTitleRequest(req)) {
        forkCount += 1
        return { text: `Auto Title ${forkCount}` }
      }
      return { text: 'answer' }
    })

    await say(env, null, 'Turn 1')
    await flushAsync()
    const sessionId = env.slice.getState().activeId
    assert.ok(sessionId)
    assert.equal(forkCount, 1)

    env.slice.commands.renameSession(sessionId, 'My Custom Name')
    await say(env, sessionId, 'Turn 2')
    await flushAsync()
    assert.equal(forkCount, 1, 'locked session does not fork for auto-title')
    assert.equal(
      env.slice.getState().sessions.find((s) => s.id === sessionId)?.title,
      'My Custom Name'
    )

    env.slice.commands.renameSession(sessionId, '')
    await say(env, sessionId, 'Turn 3')
    await flushAsync()
    assert.equal(forkCount, 2)
    assert.equal(
      env.slice.getState().sessions.find((s) => s.id === sessionId)?.title,
      'Auto Title 2'
    )
  })

  it('ignores tool_use emitted during the rename fork without executing any tool', async () => {
    env.slice.commands.newChat()
    const runsBefore = env.runs.length
    let forkNumber = 0
    env.respondWith((req): ApiReply => {
      if (isAutoTitleRequest(req)) {
        forkNumber += 1
        return forkNumber === 1
          ? { text: 'Safe Title' }
          : { calls: [{ name: 'run_code', input: { code: '1+1' } }] }
      }
      return { text: 'done' }
    })

    await say(env, null, 'Turn 1')
    await flushAsync()
    const sessionId = env.slice.getState().activeId
    assert.ok(sessionId)
    await say(env, sessionId, 'Turn 2')
    await flushAsync()

    assert.equal(env.runs.length, runsBefore, 'rename fork never executes tools')
    assert.equal(env.slice.getState().sessions.find((s) => s.id === sessionId)?.title, 'Safe Title')
  })

  it('aborts an in-flight rename fork when the user sends a new turn', async () => {
    env.slice.commands.newChat()
    let forkSignal: AbortSignal | undefined
    let releaseFork: ((reply: ApiReply) => void) | undefined
    let forkCalls = 0

    env.respondWith((req, signal): ApiReply | Promise<ApiReply> => {
      if (isAutoTitleRequest(req)) {
        forkCalls += 1
        if (forkCalls === 1) {
          return { text: 'Turn 1 Title' }
        }
        if (forkCalls === 2) {
          forkSignal = signal
          return new Promise<ApiReply>((resolve) => {
            releaseFork = resolve
          })
        }
        return { text: 'Fresh Turn 3 Title' }
      }
      return { text: 'ok' }
    })

    await say(env, null, 'Turn 1')
    await flushAsync()
    const sessionId = env.slice.getState().activeId
    assert.ok(sessionId)

    await say(env, sessionId, 'Turn 2')
    await flushAsync()
    assert.equal(forkCalls, 2)
    assert.equal(forkSignal?.aborted, false)

    await say(env, sessionId, 'Turn 3')
    assert.equal(forkSignal?.aborted, true)
    releaseFork?.({ text: 'Stale Turn 2 Title' })
    await flushAsync()

    assert.equal(
      env.slice.getState().sessions.find((s) => s.id === sessionId)?.title,
      'Fresh Turn 3 Title'
    )
  })
})
