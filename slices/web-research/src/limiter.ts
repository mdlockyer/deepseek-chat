/**
 * Shared Firecrawl rate limiter, concurrency gate, and per-reply credit tracker.
 * Enforces a sliding-window per-minute request cap by key mode, caps simultaneous in-flight
 * requests, pauses queued callers on HTTP 429 backoff, and enforces a per-reply credit budget
 * (search: 2 credits per 10 results, scrape: 1 credit) with refunds on failed or aborted calls.
 */

export type LimiterConfig = {
  /** Sliding window length in ms (default 60_000 = 1 minute). */
  readonly rateWindowMs: number
  /** Requests allowed per window when running keyless. */
  readonly keylessRatePerMinute: number
  /** Requests allowed per window when a Firecrawl API key is set. */
  readonly keyedRatePerMinute: number
  /** Maximum simultaneous in-flight Firecrawl requests across all callers. */
  readonly maxConcurrentRequests: number
  /** Base pause applied to subsequent queued calls after an HTTP 429 response (ms). */
  readonly backoff429Ms: number
  /** Maximum Firecrawl credits spent within one reply (0 or negative = unlimited). */
  readonly maxCreditsPerReply: number
}

export const sleepAbortable = (ms: number, signal: AbortSignal): Promise<void> =>
  new Promise<void>((resolve, reject) => {
    if (signal.aborted) {
      reject(signal.reason ?? new DOMException('Aborted', 'AbortError'))
      return
    }
    if (ms <= 0) {
      resolve()
      return
    }
    const onAbort = () => {
      clearTimeout(timer)
      reject(signal.reason ?? new DOMException('Aborted', 'AbortError'))
    }
    const timer = setTimeout(() => {
      signal.removeEventListener('abort', onAbort)
      resolve()
    }, ms)
    signal.addEventListener('abort', onAbort, { once: true })
  })

export const searchCredits = (limit: number): number => Math.max(1, Math.ceil(limit / 10)) * 2
export const SCRAPE_CREDITS = 1

export type CreditReservation = {
  /** Refund the reserved credits (idempotent). Call when the request fails or is aborted. */
  refund(): void
}

export type SlotLease = {
  /** Release the in-flight concurrency slot (idempotent). Always call in a `finally` block. */
  release(): void
}

export type FirecrawlLimiter = {
  /**
   * Reserves credit budget for `replyKey` before sending any request.
   * Returns `{ ok: false, message }` if the per-reply budget would be exceeded.
   */
  reserveCredits(
    replyKey: string | undefined,
    credits: number
  ): { ok: true; reservation: CreditReservation } | { ok: false; message: string }
  /**
   * Waits for both a rate-limit window slot and an in-flight concurrency slot.
   * Throws on caller abort. Caller must call `lease.release()` when the HTTP request settles.
   */
  acquireSlot(options: { hasKey: boolean; signal: AbortSignal }): Promise<SlotLease>
  /**
   * Records an HTTP 429 so subsequent queued callers pause before hitting Firecrawl again.
   * When `delayMs` is omitted, defaults to `config.backoff429Ms`.
   */
  noteRateLimited(delayMs?: number): void
  /** Credits currently charged for a given replyKey (for diagnostics / tests). */
  creditsUsed(replyKey: string): number
}

export const createFirecrawlLimiter = (
  config: LimiterConfig,
  clock: () => number = () => Date.now()
): FirecrawlLimiter => {
  const timestamps: number[] = []
  const replyCredits = new Map<string, number>()
  const maxConcurrent = Math.max(1, Math.trunc(config.maxConcurrentRequests))
  let inFlight = 0
  let concurrencyWaiters: Array<() => void> = []
  let backoffUntil = 0
  // Serialize slot acquisition so concurrent bursts strictly respect window and concurrency caps.
  let gate: Promise<void> = Promise.resolve()

  const prune = (now: number) => {
    const cutoff = now - config.rateWindowMs
    while (timestamps.length > 0 && timestamps[0] <= cutoff) {
      timestamps.shift()
    }
  }

  const waitForConcurrencySlot = (signal: AbortSignal): Promise<void> => {
    if (inFlight < maxConcurrent) {
      return Promise.resolve()
    }
    return new Promise<void>((resolve, reject) => {
      if (signal.aborted) {
        reject(signal.reason ?? new DOMException('Aborted', 'AbortError'))
        return
      }
      const wake = () => {
        signal.removeEventListener('abort', onAbort)
        resolve()
      }
      const onAbort = () => {
        concurrencyWaiters = concurrencyWaiters.filter((entry) => entry !== wake)
        reject(signal.reason ?? new DOMException('Aborted', 'AbortError'))
      }
      concurrencyWaiters.push(wake)
      signal.addEventListener('abort', onAbort, { once: true })
    })
  }

  const makeLease = (): SlotLease => {
    let released = false
    return {
      release: () => {
        if (released) {
          return
        }
        released = true
        inFlight = Math.max(0, inFlight - 1)
        const next = concurrencyWaiters.shift()
        next?.()
      },
    }
  }

  const acquireUnderGate = async (hasKey: boolean, signal: AbortSignal): Promise<SlotLease> => {
    const rate = Math.max(1, hasKey ? config.keyedRatePerMinute : config.keylessRatePerMinute)
    for (;;) {
      if (signal.aborted) {
        throw signal.reason ?? new DOMException('Aborted', 'AbortError')
      }
      if (inFlight >= maxConcurrent) {
        await waitForConcurrencySlot(signal)
        continue
      }
      const now = clock()
      prune(now)
      const waitForBackoff = backoffUntil > now ? backoffUntil - now : 0
      const waitForWindow =
        timestamps.length >= rate ? Math.max(1, timestamps[0] + config.rateWindowMs - now) : 0
      const waitMs = Math.max(waitForBackoff, waitForWindow)
      if (waitMs === 0) {
        timestamps.push(now)
        inFlight += 1
        return makeLease()
      }
      await sleepAbortable(waitMs, signal)
    }
  }

  const reserveCredits: FirecrawlLimiter['reserveCredits'] = (replyKey, credits) => {
    if (!replyKey || config.maxCreditsPerReply <= 0) {
      return { ok: true, reservation: { refund: () => undefined } }
    }
    const used = replyCredits.get(replyKey) ?? 0
    if (used + credits > config.maxCreditsPerReply) {
      return {
        ok: false,
        message: `Firecrawl per-reply credit budget reached (${used}/${config.maxCreditsPerReply} credits used; this call needs ${credits}). Finish with the information already gathered.`,
      }
    }
    replyCredits.set(replyKey, used + credits)
    let refunded = false
    return {
      ok: true,
      reservation: {
        refund: () => {
          if (refunded) {
            return
          }
          refunded = true
          const current = replyCredits.get(replyKey) ?? 0
          replyCredits.set(replyKey, Math.max(0, current - credits))
        },
      },
    }
  }

  const acquireSlot: FirecrawlLimiter['acquireSlot'] = async ({ hasKey, signal }) => {
    const previous = gate
    let releaseGate!: () => void
    gate = new Promise<void>((resolve) => {
      releaseGate = resolve
    })
    try {
      await previous
      return await acquireUnderGate(hasKey, signal)
    } finally {
      releaseGate()
    }
  }

  const noteRateLimited = (delayMs?: number) => {
    const pause = delayMs ?? config.backoff429Ms
    if (pause > 0) {
      backoffUntil = Math.max(backoffUntil, clock() + pause)
    }
  }

  const creditsUsed = (replyKey: string) => replyCredits.get(replyKey) ?? 0

  return { reserveCredits, acquireSlot, noteRateLimited, creditsUsed }
}
