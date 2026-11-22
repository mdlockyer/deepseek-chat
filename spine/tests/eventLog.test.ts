import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import {
  CausalLoopError,
  EventLog,
  type CausalEnvelope,
  type FactHandler,
} from '@deepseek-chat/spine/runtime'

type Counter = { readonly type: 'Counter'; readonly value: number }
type Ping = { readonly type: 'Ping'; readonly n: number }
type Pong = { readonly type: 'Pong'; readonly n: number }

const fixedClock = { nowMs: () => 1_700_000_000_000 }

describe('EventLog sticky store', () => {
  it('replays only the latest fact per (type, key) to a late subscriber', () => {
    const log = new EventLog({ clock: fixedClock })
    log.publishSticky<Counter>('a', { type: 'Counter', value: 1 })
    log.publishSticky<Counter>('b', { type: 'Counter', value: 10 })
    log.publishSticky<Counter>('a', { type: 'Counter', value: 2 })

    const seen: [string | null, number][] = []
    log.subscribe<Counter>('Counter', (envelope) => {
      seen.push([envelope.stickyKey, envelope.fact.value])
    })

    // 'a' was published twice; only its latest value (2) survives compaction.
    assert.deepEqual(
      seen.sort(([a], [b]) => String(a).localeCompare(String(b))),
      [
        ['a', 2],
        ['b', 10],
      ]
    )
  })

  it('does not replay discrete facts to late subscribers', () => {
    const log = new EventLog()
    log.publish<Ping>({ type: 'Ping', n: 1 })

    const seen: number[] = []
    log.subscribe<Ping>('Ping', (envelope) => seen.push(envelope.fact.n))
    log.publish<Ping>({ type: 'Ping', n: 2 })

    assert.deepEqual(seen, [2])
  })

  it('skips the snapshot when replaySticky is false but still delivers new facts', () => {
    const log = new EventLog()
    log.publishSticky<Counter>('unit', { type: 'Counter', value: 1 })

    const seen: number[] = []
    log.subscribe<Counter>('Counter', (envelope) => seen.push(envelope.fact.value), {
      replaySticky: false,
    })
    log.publishSticky<Counter>('unit', { type: 'Counter', value: 2 })

    assert.deepEqual(seen, [2])
  })

  it('evicts a tombstoned key, tells live subscribers, and hides it from later ones', () => {
    const log = new EventLog()
    log.publishSticky<Counter>('a', { type: 'Counter', value: 1 })
    log.publishSticky<Counter>('b', { type: 'Counter', value: 2 })

    const evicted: string[] = []
    log.subscribe<Counter>('Counter', () => undefined, {
      onTombstone: (key) => evicted.push(key),
    })
    log.tombstone('Counter', 'a')

    assert.deepEqual(evicted, ['a'])
    assert.equal(log.getSticky<Counter>('Counter', 'a'), undefined)
    assert.deepEqual(log.listSticky<Counter>('Counter'), [['b', { type: 'Counter', value: 2 }]])

    const late: string[] = []
    log.subscribe<Counter>('Counter', (envelope) => late.push(String(envelope.stickyKey)))
    assert.deepEqual(late, ['b'])
  })

  it('treats tombstoning an absent key as a no-op', () => {
    const log = new EventLog()
    const evicted: string[] = []
    log.subscribe<Counter>('Counter', () => undefined, {
      onTombstone: (key) => evicted.push(key),
    })

    assert.equal(log.tombstone('Counter', 'missing'), null)
    assert.deepEqual(evicted, [])
    assert.equal(log.history().length, 0)
  })

  it('rejects an empty compaction key', () => {
    const log = new EventLog()
    assert.throws(
      () => log.publishSticky<Counter>('', { type: 'Counter', value: 1 }),
      /Sticky fact "Counter" requires a non-empty compaction key/
    )
  })

  it('reserves the Tombstone fact type', () => {
    const log = new EventLog()
    assert.throws(() => log.publish({ type: 'Tombstone' }), /"Tombstone" is reserved/)
    assert.throws(() => log.subscribe('Tombstone', () => undefined), /"Tombstone" is reserved/)
  })

  it('stops delivering after unsubscribe', () => {
    const log = new EventLog()
    const seen: number[] = []
    const unsubscribe = log.subscribe<Ping>('Ping', (envelope) => seen.push(envelope.fact.n))
    log.publish<Ping>({ type: 'Ping', n: 1 })
    unsubscribe()
    log.publish<Ping>({ type: 'Ping', n: 2 })

    assert.deepEqual(seen, [1])
  })

  it('matches a reference keyed map across random publish/tombstone sequences', () => {
    // Spec: the store is compacted by (FactType, Key): latest publication wins, tombstones evict.
    // Reference model: Map<type, Map<key, value>>.
    let seed = 0x5eed
    const random = (n: number) => {
      seed = (seed * 1_103_515_245 + 12_345) % 2 ** 31
      return seed % n
    }
    const types = ['Counter', 'Gauge'] as const
    const keys = ['unit', 'k1', 'k2', 'k3']

    for (let run = 0; run < 50; run += 1) {
      const log = new EventLog({ historyLimit: 0 })
      const model = new Map<string, Map<string, number>>(types.map((t) => [t, new Map()]))

      for (let step = 0; step < 40; step += 1) {
        const type = types[random(types.length)] ?? 'Counter'
        const key = keys[random(keys.length)] ?? 'unit'
        const bucket = model.get(type) ?? new Map<string, number>()
        if (random(3) === 0) {
          log.tombstone(type, key)
          bucket.delete(key)
        } else {
          const value = random(1000)
          log.publishSticky(key, { type, value })
          bucket.set(key, value)
        }
      }

      for (const type of types) {
        const expected = [...(model.get(type) ?? [])].sort(([a], [b]) => a.localeCompare(b))
        const actual = log
          .listSticky<{ type: string; value: number }>(type)
          .map(([key, fact]): [string, number] => [key, fact.value])
          .sort(([a], [b]) => a.localeCompare(b))
        assert.deepEqual(actual, expected, `run ${run}, type ${type}`)

        const replayed: [string, number][] = []
        log.subscribe<{ type: string; value: number }>(type, (envelope) => {
          replayed.push([String(envelope.stickyKey), envelope.fact.value])
        })
        assert.deepEqual(
          replayed.sort(([a], [b]) => a.localeCompare(b)),
          expected,
          `replay run ${run}, type ${type}`
        )
      }
    }
  })
})

describe('EventLog causal envelopes', () => {
  it('starts top-level facts at hop 0 with no cause', () => {
    const log = new EventLog({ clock: fixedClock })
    const envelope = log.publish<Ping>({ type: 'Ping', n: 1 })

    assert.equal(envelope.hopDepth, 0)
    assert.equal(envelope.causationId, null)
    assert.equal(envelope.timestamp, 1_700_000_000_000)
  })

  it('links a fact emitted inside a handler to its trigger and increments hopDepth', () => {
    const log = new EventLog()
    const pongs: CausalEnvelope<Pong>[] = []
    log.subscribe<Ping>('Ping', (envelope) => {
      log.publish<Pong>({ type: 'Pong', n: envelope.fact.n })
    })
    log.subscribe<Pong>('Pong', (envelope) => pongs.push(envelope))

    const ping = log.publish<Ping>({ type: 'Ping', n: 7 })

    assert.equal(pongs.length, 1)
    assert.equal(pongs[0]?.causationId, ping.id)
    assert.equal(pongs[0]?.hopDepth, 1)
  })

  it('links facts emitted while handling a tombstone to the tombstone', () => {
    const log = new EventLog()
    log.publishSticky<Counter>('a', { type: 'Counter', value: 1 })
    const pongs: CausalEnvelope<Pong>[] = []
    log.subscribe<Pong>('Pong', (envelope) => pongs.push(envelope))
    log.subscribe<Counter>('Counter', () => undefined, {
      replaySticky: false,
      onTombstone: () => {
        log.publish<Pong>({ type: 'Pong', n: 0 })
      },
    })

    const tombstone = log.tombstone('Counter', 'a')

    assert.equal(pongs[0]?.causationId, tombstone?.id)
    assert.equal(pongs[0]?.hopDepth, 1)
  })

  it('breaks a feedback loop at maxHops with the causal chain', () => {
    const maxHops = 5
    const log = new EventLog({ maxHops })
    log.subscribe<Ping>('Ping', (envelope) => {
      log.publish<Pong>({ type: 'Pong', n: envelope.fact.n + 1 })
    })
    log.subscribe<Pong>('Pong', (envelope) => {
      log.publish<Ping>({ type: 'Ping', n: envelope.fact.n + 1 })
    })

    assert.throws(
      () => log.publish<Ping>({ type: 'Ping', n: 0 }),
      (error: unknown) => {
        assert.ok(error instanceof CausalLoopError)
        // Hops 0..4 are emitted (Ping, Pong, Ping, Pong, Ping); the Pong at hop 5 is blocked.
        assert.equal(error.hopDepth, maxHops)
        assert.equal(error.maxHops, maxHops)
        assert.deepEqual(
          error.chain.map((link) => link.split('#')[0]),
          ['Ping', 'Pong', 'Ping', 'Pong', 'Ping', 'Pong']
        )
        assert.equal(error.chain.at(-1), 'Pong#blocked')
        return true
      }
    )
  })

  it('returns to hop 0 after a handler throws', () => {
    const reported: unknown[] = []
    const log = new EventLog({ onHandlerError: (error) => reported.push(error) })
    const failing: FactHandler<Ping> = () => {
      throw new Error('handler failed')
    }
    const unsubscribe = log.subscribe<Ping>('Ping', failing)
    log.publish<Ping>({ type: 'Ping', n: 1 })
    assert.equal(reported.length, 1)
    unsubscribe()

    const next = log.publish<Ping>({ type: 'Ping', n: 2 })
    assert.equal(next.hopDepth, 0)
    assert.equal(next.causationId, null)
  })

  it('isolates a failing subscriber: the others still get the fact and the publisher goes on', () => {
    const reported: [unknown, string][] = []
    const log = new EventLog({
      onHandlerError: (error, envelope) => reported.push([error, envelope.fact.type]),
    })
    const seen: string[] = []
    log.subscribe<Ping>('Ping', () => {
      throw new Error('first failed')
    })
    log.subscribe<Ping>('Ping', ({ fact }) => seen.push(`second ${fact.n}`))

    const envelope = log.publish<Ping>({ type: 'Ping', n: 7 })
    assert.equal(envelope.fact.n, 7)
    assert.deepEqual(seen, ['second 7'])
    assert.equal(reported.length, 1)
    assert.match(String(reported[0]?.[0]), /first failed/)
    assert.equal(reported[0]?.[1], 'Ping')

    // Tombstone delivery is isolated the same way.
    const evicted: string[] = []
    log.subscribe<Counter>('Counter', () => undefined, {
      onTombstone: () => {
        throw new Error('tombstone handler failed')
      },
    })
    log.subscribe<Counter>('Counter', () => undefined, {
      onTombstone: (key) => evicted.push(key),
    })
    log.publishSticky<Counter>('a', { type: 'Counter', value: 1 })
    assert.ok(log.tombstone('Counter', 'a'))
    assert.deepEqual(evicted, ['a'])
    assert.equal(reported.length, 2)
  })
})

describe('EventLog history', () => {
  it('keeps only the most recent historyLimit envelopes, oldest first', () => {
    const log = new EventLog({ historyLimit: 3 })
    for (let n = 1; n <= 5; n += 1) {
      log.publish<Ping>({ type: 'Ping', n })
    }

    // 5 published, limit 3 => the last three: 3, 4, 5.
    assert.deepEqual(
      log.history().map((envelope) => (envelope.fact as Ping).n),
      [3, 4, 5]
    )
  })

  it('rejects invalid construction options', () => {
    assert.throws(() => new EventLog({ maxHops: 0 }), /maxHops must be a positive integer/)
    assert.throws(() => new EventLog({ historyLimit: -1 }), /historyLimit must be a non-negative/)
  })
})
