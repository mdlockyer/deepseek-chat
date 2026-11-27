import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { memoryBlobStore, memoryNoticePort, memoryStore } from '@deepseek-chat/test-support'

describe('test-support: memoryStore', () => {
  it('reads, writes, and deletes string keys in isolation', () => {
    const store = memoryStore({ a: '1' })
    assert.equal(store.get('a'), '1')
    assert.equal(store.get('missing'), null)
    store.set('b', '2')
    assert.equal(store.get('b'), '2')
    store.set('a', null)
    assert.equal(store.get('a'), null)
  })
})

describe('test-support: memoryBlobStore', () => {
  it('stores, retrieves, deletes, clears, and atomically replaces blobs', async () => {
    const store = memoryBlobStore([
      { id: 'seed', blob: new Blob(['hello'], { type: 'text/plain' }) },
    ])
    assert.equal(await (await store.get('seed'))?.text(), 'hello')
    assert.equal(await store.get('missing'), undefined)

    await store.put([
      { id: 'a', blob: new Blob(['alpha']) },
      { id: 'b', blob: new Blob(['beta']) },
    ])
    assert.equal(await (await store.get('a'))?.text(), 'alpha')
    assert.equal(await (await store.get('b'))?.text(), 'beta')

    await store.delete(['a'])
    assert.equal(await store.get('a'), undefined)
    assert.equal(await (await store.get('b'))?.text(), 'beta')

    await store.replaceAll([{ id: 'c', blob: new Blob(['gamma']) }])
    assert.equal(await store.get('seed'), undefined)
    assert.equal(await store.get('b'), undefined)
    assert.equal(await (await store.get('c'))?.text(), 'gamma')

    await store.clear()
    assert.equal(await store.get('c'), undefined)
  })
})

describe('test-support: memoryNoticePort', () => {
  it('records notices in order and exposes latest / clear cleanly', () => {
    const notices = memoryNoticePort()
    assert.equal(notices.latest(), null)
    assert.equal(notices.history.length, 0)

    const first = { text: () => 'Saved' }
    const second = { text: () => 'Failed', tone: 'error' as const }
    notices.show(first)
    notices.show(second)

    assert.equal(notices.latest(), second)
    const snapshot = notices.history
    assert.equal(snapshot.length, 2)
    assert.equal(snapshot[0]?.text(), 'Saved')
    assert.equal(snapshot[1]?.tone, 'error')

    notices.clear()
    assert.equal(notices.latest(), null)
    assert.equal(snapshot.length, 2)
  })
})
