import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import type { SessionDeleted, SessionHistoryReplaced } from '@deepseek-chat/spine/facts/session'
import { EventLog } from '@deepseek-chat/spine/runtime'
import { ASK_USER_TOOL_NAME, createAskUserSlice } from '@deepseek-chat/slice-ask-user'

const sampleQuestion = {
  questions: [
    {
      id: 'theme',
      header: 'Theme',
      question: 'Which theme do you prefer?',
      options: [{ label: 'Dark', recommended: true }, { label: 'Light' }],
    },
  ],
}

describe('slice-ask-user: input validation at boundary', () => {
  it('rejects invalid input and deduplicates duplicate question IDs through slice.run', async () => {
    const slice = createAskUserSlice({ log: new EventLog() })
    const signal = new AbortController().signal

    assert.equal((await slice.run(null, { sessionId: 's1', signal })).status, 'error')
    assert.equal((await slice.run({ questions: [] }, { sessionId: 's1', signal })).status, 'error')

    const pending = slice.run(
      {
        questions: [
          { id: 'q', header: 'One', question: 'First?' },
          { id: 'q', header: 'Two', question: 'Second?' },
        ],
      },
      { sessionId: 's1', signal }
    )
    assert.equal(slice.submit('s1', { q: 'A', q_2: 'B' }), true)
    const result = await pending
    assert.equal(result.status, 'ok')
    assert.deepEqual(JSON.parse(result.content), {
      status: 'answered',
      answers: { q: 'A', q_2: 'B' },
    })
    slice.dispose()
  })
})

describe('slice-ask-user: interactive lifecycle & isolation', () => {
  it('handles submit, skip, abort, SessionDeleted, and SessionHistoryReplaced', async () => {
    const log = new EventLog()
    const slice = createAskUserSlice({ log })

    // Submit path
    const p1 = slice.run(sampleQuestion, { sessionId: 's1', signal: new AbortController().signal })
    assert.equal(slice.submit('s1', { theme: 'Dark' }), true)
    assert.equal(slice.submit('s1', { theme: 'Dark' }), false, 'already settled')
    const r1 = await p1
    assert.equal(r1.status, 'ok')
    assert.equal(r1.askAction?.status, 'answered')
    assert.equal(r1.frontStageNote?.status, 'done')
    assert.equal(r1.frontStageNote?.items[0]?.value, 'Dark')
    assert.deepEqual(JSON.parse(r1.content), { status: 'answered', answers: { theme: 'Dark' } })

    // Skip path
    const p2 = slice.run(sampleQuestion, { sessionId: 's1', signal: new AbortController().signal })
    assert.equal(slice.skip('s1'), true)
    const r2 = await p2
    assert.equal(r2.status, 'ok')
    assert.equal(r2.askAction?.status, 'skipped')
    assert.equal(r2.frontStageNote?.status, 'skipped')

    // Abort path
    const ac = new AbortController()
    const p3 = slice.run(sampleQuestion, { sessionId: 's1', signal: ac.signal })
    ac.abort()
    assert.equal((await p3).status, 'aborted')

    // SessionDeleted aborts only that session's prompt
    const pS1 = slice.run(sampleQuestion, { sessionId: 's1', signal: new AbortController().signal })
    const pS2 = slice.run(sampleQuestion, { sessionId: 's2', signal: new AbortController().signal })
    log.publish<SessionDeleted>({ type: 'SessionDeleted', sessionId: 's1' })
    assert.equal((await pS1).status, 'aborted')
    assert.equal(slice.submit('s2', { theme: 'Light' }), true)
    assert.equal((await pS2).status, 'ok')

    // SessionHistoryReplaced aborts remaining prompts
    const pS3 = slice.run(sampleQuestion, { sessionId: 's3', signal: new AbortController().signal })
    log.publish<SessionHistoryReplaced>({ type: 'SessionHistoryReplaced' })
    assert.equal((await pS3).status, 'aborted')

    // Archive serialization via capability
    const archived = slice.capability.serializeForArchive?.(
      { id: 'c1', name: ASK_USER_TOOL_NAME, input: sampleQuestion },
      {
        tool_use_id: 'c1',
        content: r1.content,
        status: 'ok',
        payload: r1.payload,
      }
    )
    assert.ok(
      archived && archived[0]?.type === 'MARKDOWN' && archived[0].content.includes('Theme: Dark')
    )

    slice.dispose()
  })

  it('keeps two instances completely isolated', async () => {
    const a = createAskUserSlice({ log: new EventLog() })
    const b = createAskUserSlice({ log: new EventLog() })

    const pendingA = a.run(sampleQuestion, {
      sessionId: 'same-id',
      signal: new AbortController().signal,
    })
    assert.equal(b.submit('same-id', { theme: 'Dark' }), false)
    assert.equal(a.submit('same-id', { theme: 'Light' }), true)
    assert.equal((await pendingA).askAction?.items[0]?.answer, 'Light')

    a.dispose()
    b.dispose()
  })
})
