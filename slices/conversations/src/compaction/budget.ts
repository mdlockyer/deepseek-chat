import type { ModelSpec } from '@deepseek-chat/lib-agent'
import type { CompactionTrigger } from '../types.js'

export type CompactionPolicy = {
  /** Model context window used to derive this policy. */
  readonly contextWindow: number
  /** Display percentage of `contextWindow` at which auto-compaction fires (70% at <=200K -> 50% at >=1M). */
  readonly thresholdPercent: number
  /** Tokens reserved for the model's output and estimator safety margin. */
  readonly responseReserve: number
  /** Hard request ceiling (`contextWindow - responseReserve`). Requests at or above trigger `fit`. */
  readonly ceiling: number
  /** Proactive auto-compaction line (`turnStart` / `betweenRounds`). Strictly below `ceiling`. */
  readonly line: number
  /** Maximum token budget for the rendered checkpoint itself (half of `line`). */
  readonly maxCheckpointTokens: number
  /** Target token budget for recent messages kept verbatim (20K at <=200K -> 40K at >=1M, capped at 25% of window). */
  readonly keepRecentTokens: number
}

const MIN_WINDOW = 4_096
const SMALL_WINDOW_ANCHOR = 200_000
const LARGE_WINDOW_ANCHOR = 1_000_000

const clamp01 = (value: number): number => Math.min(1, Math.max(0, value))

/**
 * Derives window-adaptive compaction thresholds directly from `ModelSpec.contextWindow` and
 * `maxOutputTokens`. Smoothly scales from 70% line / 20K verbatim keep on <=200K windows to
 * 50% line / 40K verbatim keep on >=1M windows, while keeping `line` strictly monotonic.
 */
export const computeCompactionPolicy = (spec: ModelSpec): CompactionPolicy => {
  const contextWindow = Math.max(MIN_WINDOW, Math.trunc(spec.contextWindow))
  const t = clamp01(
    (contextWindow - SMALL_WINDOW_ANCHOR) / (LARGE_WINDOW_ANCHOR - SMALL_WINDOW_ANCHOR)
  )
  const thresholdRatio = (70 - 20 * t) / 100
  const thresholdPercent = Math.round(thresholdRatio * 100)

  const cappedOutput = Math.min(
    Math.max(Math.trunc(spec.maxOutputTokens), 16_384),
    Math.floor(contextWindow * 0.1)
  )
  const estimatorMargin = Math.min(4_096, Math.floor(contextWindow * 0.05))
  const responseReserve = cappedOutput + estimatorMargin
  const ceiling = Math.max(1_024, contextWindow - responseReserve)
  const headroom = Math.floor(ceiling * 0.1)
  const line = Math.max(
    1_024,
    Math.min(Math.floor(contextWindow * thresholdRatio), ceiling - headroom)
  )
  const maxCheckpointTokens = Math.max(512, Math.floor(line * 0.5))
  const rawKeep = Math.round(20_000 + 20_000 * t)
  const keepRecentTokens = Math.max(512, Math.min(rawKeep, Math.floor(contextWindow * 0.25)))

  return {
    contextWindow,
    thresholdPercent,
    responseReserve,
    ceiling,
    line,
    maxCheckpointTokens,
    keepRecentTokens,
  }
}

/**
 * Decides whether a request at `estimatedTokens` should trigger compaction before sending.
 * Checks `fit` (hard ceiling) first, then the proactive `line` unless it already failed this turn.
 */
export const selectCompactionTrigger = (
  estimatedTokens: number,
  policy: CompactionPolicy,
  phase: 'turnStart' | 'betweenRounds',
  lineFailedThisTurn: boolean
): CompactionTrigger | null => {
  if (estimatedTokens >= policy.ceiling) {
    return 'fit'
  }
  if (!lineFailedThisTurn && estimatedTokens >= policy.line) {
    return phase
  }
  return null
}
