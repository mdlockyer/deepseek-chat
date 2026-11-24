/**
 * Shared Firecrawl rate limiter and per-reply credit tracker.
 * Enforces a sliding-window per-minute request cap by key mode, backs off on HTTP 429,
 * and enforces a per-reply credit budget (search: 2 credits per 10 results, scrape: 1 credit).
 */

export type LimiterConfig = {
  /** Sliding window length in ms (default 60_000 = 1 minute). */
  readonly rateWindowMs: number
  /** Requests allowed per window when running keyless. */
  readonly keylessRatePerMinute: number
  /** Requests allowed per window when a Firecrawl API key is set. */
  readonly keyedRatePerMinute: number
  /** Pause applied to subsequent queued calls after an HTTP 429 response (ms). */
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

export type FirecrawlLimiter = {
  /**
   * Reserves credit budget (if `replyKey` is given) and waits for a rate-limit slot.
   * Returns `{ ok: false, message }` if the per-reply credit budget would be exceeded.
   * Throws on caller abort.
   */
  acquire(options: {
    hasKey: boolean
    credits: number
    replyKey?: string
    signal: AbortSignal
  }): Promise<{ ok: true } | { ok: false; message: string }>
  /** Records an HTTP 429 so subsequent calls pause before hitting Firecrawl again. */
  noteRateLimited(): void
  /** Credits recorded for a given replyKey (for diagnostics / tests). */
  creditsUsed(replyKey: string): number
}

export const createFirecrawlLimiter = (
  config: LimiterConfig,
  clock: () => number = () => Date.now()
): FirecrawlLimiter => {
  const timestamps: number[] = []
  const replyCredits = new Map<string, number>()
  let backoffUntil = 0
  // Serialize slot acquisition so concurrent bursts strictly respect the window cap.
  let gate: Promise<void> = Promise.resolve()

  const prune = (now: number) => {
    const cutoff = now - config.rateWindowMs
    while (timestamps.length > 0 && timestamps[0] <= cutoff) {
      timestamps.shift()
    }
  }

  const acquireSlot = async (hasKey: boolean, signal: AbortSignal): Promise<void> => {
    const rate = Math.max(1, hasKey ? config.keyedRatePerMinute : config.keylessRatePerMinute)
    for (;;) {
      if (signal.aborted) {
        throw signal.reason ?? new DOMException('Aborted', 'AbortError')
      }
      const now = clock()
      prune(now)
      const waitForBackoff = backoffUntil > now ? backoffUntil - now : 0
      const waitForWindow =
        timestamps.length >= rate ? Math.max(1, timestamps[0] + config.rateWindowMs - now) : 0
      const waitMs = Math.max(waitForBackoff, waitForWindow)
      if (waitMs === 0) {
        timestamps.push(now)
        return
      }
      await sleepAbortable(waitMs, signal)
    }
  }

  const acquire: FirecrawlLimiter['acquire'] = async ({ hasKey, credits, replyKey, signal }) => {
    // Check and reserve credit budget atomically before waiting on the rate limiter.
    if (replyKey && config.maxCreditsPerReply > 0) {
      const used = replyCredits.get(replyKey) ?? 0
      if (used + credits > config.maxCreditsPerReply) {
        return {
          ok: false,
          message: `Firecrawl per-reply credit budget reached (${used}/${config.maxCreditsPerReply} credits used; this call needs ${credits}). Finish with the information already gathered.`,
        }
      }
      replyCredits.set(replyKey, used + credits)
    }

    const previous = gate
    let release!: () => void
    gate = new Promise<void>((resolve) => {
      release = resolve
    })
    try {
      await previous
      await acquireSlot(hasKey, signal)
      return { ok: true }
    } catch (error) {
      // Refund reserved credits if aborted while waiting for a rate slot.
      if (replyKey && config.maxCreditsPerReply > 0) {
        const current = replyCredits.get(replyKey) ?? 0
        replyCredits.set(replyKey, Math.max(0, current - credits))
      }
      throw error
    } finally {
      release()
    }
  }

  const noteRateLimited = () => {
    if (config.backoff429Ms > 0) {
      backoffUntil = Math.max(backoffUntil, clock() + config.backoff429Ms)
    }
  }

  const creditsUsed = (replyKey: string) => replyCredits.get(replyKey) ?? 0

  return { acquire, noteRateLimited, creditsUsed }
}
