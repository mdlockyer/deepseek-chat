import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { memoryBlobStore } from '@deepseek-chat/spine/ports'

describe('spine/ports: memoryBlobStore', () => {
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
