import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { appendBranch, getVisibleMessages, normalizeSession, selectVersion } from './branches.js'
import type { Session, UserMessage } from './types.js'

const makeUser = (id: string, content: string): UserMessage => ({
  id,
  role: 'user',
  content,
  files: [],
  createdAt: 1_000,
})

describe('branches', () => {
  it('switches between sibling versions and computes the visible path', () => {
    let session: Session = {
      id: 's1',
      title: 'Test',
      createdAt: 1_000,
      updatedAt: 1_000,
      rootMessageId: null,
      messages: [],
    }

    const u1 = makeUser('u1', 'v1')
    const u2 = makeUser('u2', 'v2')
    session = appendBranch(session, null, [u1])
    session = appendBranch(session, null, [u2])

    assert.deepEqual(
      getVisibleMessages(session).map((m) => m.id),
      ['u2']
    )

    session = selectVersion(session, 'u1')
    assert.deepEqual(
      getVisibleMessages(session).map((m) => m.id),
      ['u1']
    )

    const normalized = normalizeSession(session)
    assert.equal(normalized.rootMessageId, 'u1')
  })
})
