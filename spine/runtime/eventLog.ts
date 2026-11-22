/**
 * Profile 1 (stateful client) Spine EventLog.
 *
 * An ephemeral, in-process fact bus with a Keyed Sticky Store:
 * - `publish` emits a discrete fact to current subscribers only.
 * - `publishSticky` stores the fact under `(type, key)` (latest wins) and emits it; late
 *   subscribers receive the compacted snapshot on subscribe. Use the key `'unit'` for singletons.
 * - `tombstone` evicts `(type, key)` and tells live subscribers of that type.
 * - Every emission is wrapped in a causal envelope. Emitting from inside a handler links
 *   `causationId` to the triggering envelope and increments `hopDepth`; reaching `maxHops`
 *   throws `CausalLoopError` with the full chain instead of looping.
 * - A subscriber that throws is reported through `onHandlerError` and skipped; the other
 *   subscribers still receive the fact and the publisher is not interrupted.
 *
 * Domain-blind: no slice or product nouns belong in this file.
 */

export type BaseFact = { readonly type: string }

export type CausalEnvelope<TFact extends BaseFact = BaseFact> = {
  readonly id: string
  readonly timestamp: number
  readonly causationId: string | null
  readonly hopDepth: number
  /** Compaction key for sticky facts and tombstones; null for discrete facts. */
  readonly stickyKey: string | null
  readonly fact: TFact
}

/** Emitted (and kept in history) when a sticky key is evicted. */
type TombstoneFact = {
  readonly type: 'Tombstone'
  readonly targetType: string
  readonly key: string
}

export type FactHandler<TFact extends BaseFact = BaseFact> = (
  envelope: CausalEnvelope<TFact>
) => void

export type TombstoneHandler = (key: string, envelope: CausalEnvelope<BaseFact>) => void

export type SubscribeOptions = {
  /** Deliver the current sticky snapshot of this type on subscribe. Default true. */
  readonly replaySticky?: boolean
  /** Called when a sticky key of this type is tombstoned. */
  readonly onTombstone?: TombstoneHandler
}

export type EventLogClock = { nowMs(): number }

export type EventLogOptions = {
  /** Emissions at this hop depth or deeper throw CausalLoopError. Default 12. */
  readonly maxHops?: number
  /** Most recent envelopes kept for `history()`. Default 256. */
  readonly historyLimit?: number
  readonly clock?: EventLogClock
  /**
   * Receives an error thrown by a subscriber. Delivery to the other subscribers and the
   * publisher's own work go on. Default: rethrown asynchronously, so it still surfaces as an
   * uncaught error. A CausalLoopError is never isolated: it propagates to the publisher.
   */
  readonly onHandlerError?: (error: unknown, envelope: CausalEnvelope) => void
}

export class CausalLoopError extends Error {
  readonly hopDepth: number
  readonly maxHops: number
  readonly chain: readonly string[]

  constructor(hopDepth: number, maxHops: number, chain: readonly string[]) {
    super(`Causal loop: hopDepth ${hopDepth} reached maxHops ${maxHops} (${chain.join(' -> ')})`)
    this.name = 'CausalLoopError'
    this.hopDepth = hopDepth
    this.maxHops = maxHops
    this.chain = chain
  }
}

type Subscriber = {
  readonly handler: FactHandler
  readonly onTombstone: TombstoneHandler | undefined
}

const TOMBSTONE = 'Tombstone'

export class EventLog {
  readonly maxHops: number
  readonly #historyLimit: number
  readonly #clock: EventLogClock
  readonly #onHandlerError: (error: unknown, envelope: CausalEnvelope) => void
  readonly #sticky = new Map<string, Map<string, CausalEnvelope>>()
  readonly #subscribers = new Map<string, Set<Subscriber>>()
  readonly #history: CausalEnvelope[] = []
  readonly #causalStack: CausalEnvelope[] = []
  #seq = 0

  constructor(options: EventLogOptions = {}) {
    this.maxHops = options.maxHops ?? 12
    this.#historyLimit = options.historyLimit ?? 256
    this.#clock = options.clock ?? { nowMs: () => Date.now() }
    this.#onHandlerError =
      options.onHandlerError ??
      ((error) =>
        queueMicrotask(() => {
          throw error
        }))
    if (!Number.isInteger(this.maxHops) || this.maxHops < 1) {
      throw new RangeError(`maxHops must be a positive integer, got ${String(this.maxHops)}`)
    }
    if (!Number.isInteger(this.#historyLimit) || this.#historyLimit < 0) {
      throw new RangeError(
        `historyLimit must be a non-negative integer, got ${String(this.#historyLimit)}`
      )
    }
  }

  publish<TFact extends BaseFact>(fact: TFact): CausalEnvelope<TFact> {
    assertNotTombstoneType(fact.type)
    const envelope = this.#createEnvelope(fact, null)
    this.#record(envelope)
    this.#deliver(fact.type, envelope, (subscriber) => subscriber.handler(envelope))
    return envelope
  }

  publishSticky<TFact extends BaseFact>(key: string, fact: TFact): CausalEnvelope<TFact> {
    assertNotTombstoneType(fact.type)
    if (key === '') {
      throw new Error(`Sticky fact "${fact.type}" requires a non-empty compaction key`)
    }
    const envelope = this.#createEnvelope(fact, key)
    let bucket = this.#sticky.get(fact.type)
    if (!bucket) {
      bucket = new Map()
      this.#sticky.set(fact.type, bucket)
    }
    bucket.set(key, envelope)
    this.#record(envelope)
    this.#deliver(fact.type, envelope, (subscriber) => subscriber.handler(envelope))
    return envelope
  }

  /** Evicts `(type, key)`. Evicting a key that is not stored is a no-op and returns null. */
  tombstone(type: string, key: string): CausalEnvelope | null {
    const bucket = this.#sticky.get(type)
    if (!bucket?.has(key)) {
      return null
    }
    const fact: TombstoneFact = { type: TOMBSTONE, targetType: type, key }
    const envelope = this.#createEnvelope(fact, key)
    bucket.delete(key)
    this.#record(envelope)
    this.#deliver(type, envelope, (subscriber) => subscriber.onTombstone?.(key, envelope))
    return envelope
  }

  subscribe<TFact extends BaseFact>(
    type: TFact['type'],
    handler: FactHandler<TFact>,
    options: SubscribeOptions = {}
  ): () => void {
    assertNotTombstoneType(type)
    let set = this.#subscribers.get(type)
    if (!set) {
      set = new Set()
      this.#subscribers.set(type, set)
    }
    const subscriber: Subscriber = {
      handler: handler as FactHandler,
      onTombstone: options.onTombstone,
    }
    set.add(subscriber)

    if (options.replaySticky !== false) {
      const bucket = this.#sticky.get(type)
      if (bucket) {
        for (const envelope of [...bucket.values()]) {
          subscriber.handler(envelope)
        }
      }
    }

    return () => {
      set.delete(subscriber)
    }
  }

  /** Current sticky fact for `(type, key)`. Returns the same reference until it is replaced. */
  getSticky<TFact extends BaseFact>(type: TFact['type'], key: string): TFact | undefined {
    return this.#sticky.get(type)?.get(key)?.fact as TFact | undefined
  }

  /** Current sticky facts of `type` as `[key, fact]` pairs, in first-publication order. */
  listSticky<TFact extends BaseFact>(type: TFact['type']): [string, TFact][] {
    const bucket = this.#sticky.get(type)
    if (!bucket) {
      return []
    }
    return [...bucket].map(([key, envelope]) => [key, envelope.fact as TFact])
  }

  /** Most recent envelopes (oldest first), including tombstones, capped at `historyLimit`. */
  history(): readonly CausalEnvelope[] {
    return [...this.#history]
  }

  #createEnvelope<TFact extends BaseFact>(
    fact: TFact,
    stickyKey: string | null
  ): CausalEnvelope<TFact> {
    const parent = this.#causalStack.at(-1) ?? null
    const hopDepth = parent ? parent.hopDepth + 1 : 0
    if (hopDepth >= this.maxHops) {
      const chain = [
        ...this.#causalStack.map((envelope) => `${envelope.fact.type}#${envelope.id}`),
        `${fact.type}#blocked`,
      ]
      throw new CausalLoopError(hopDepth, this.maxHops, chain)
    }
    this.#seq += 1
    return {
      id: `env_${this.#seq}`,
      timestamp: this.#clock.nowMs(),
      causationId: parent ? parent.id : null,
      hopDepth,
      stickyKey,
      fact,
    }
  }

  #record(envelope: CausalEnvelope) {
    if (this.#historyLimit === 0) {
      return
    }
    this.#history.push(envelope)
    if (this.#history.length > this.#historyLimit) {
      this.#history.splice(0, this.#history.length - this.#historyLimit)
    }
  }

  /**
   * Runs `notify` for each subscriber of `type`, with `envelope` as the cause of any emission.
   * A subscriber that throws is reported and skipped; a causal loop still propagates.
   */
  #deliver(type: string, envelope: CausalEnvelope, notify: (subscriber: Subscriber) => void) {
    const subscribers = this.#subscribers.get(type)
    if (!subscribers || subscribers.size === 0) {
      return
    }
    this.#causalStack.push(envelope)
    try {
      for (const subscriber of [...subscribers]) {
        try {
          notify(subscriber)
        } catch (error) {
          if (error instanceof CausalLoopError) {
            throw error
          }
          this.#onHandlerError(error, envelope)
        }
      }
    } finally {
      this.#causalStack.pop()
    }
  }
}

const assertNotTombstoneType = (type: string) => {
  if (type === TOMBSTONE) {
    throw new Error(`"${TOMBSTONE}" is reserved by the EventLog; use tombstone(type, key)`)
  }
}
