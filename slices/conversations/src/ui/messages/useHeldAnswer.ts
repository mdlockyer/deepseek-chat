import { useEffect, useState } from 'react'
import { holdsNarration, NARRATION_HOLD_MS, type ReplyView } from '../../view.js'

/**
 * The reply's answer, or `null` while its trailing text is still held back as likely narration
 * (`holdsNarration`). Re-renders once the hold runs out, so held text appears without waiting for
 * the next stream delta.
 */
export const useHeldAnswer = (
  messageId: string,
  view: ReplyView,
  streaming: boolean
): ReplyView['answer'] => {
  // The text after the latest tool call starts afresh whenever a step is added.
  const key = `${messageId}:${view.steps.length}`
  const [since, setSince] = useState<{ readonly key: string; readonly at: number } | null>(null)
  const [, setTick] = useState(0)
  const started = view.answer !== null && streaming
  if (started && since?.key !== key) {
    setSince({ key, at: Date.now() })
  }
  const streamedMs = since?.key === key ? Date.now() - since.at : 0
  const held = holdsNarration(view, streaming, streamedMs)
  useEffect(() => {
    if (!held) {
      return
    }
    const timer = setTimeout(() => setTick((n) => n + 1), NARRATION_HOLD_MS - streamedMs + 16)
    return () => clearTimeout(timer)
  }, [held, key, streamedMs])
  return held ? null : view.answer
}
