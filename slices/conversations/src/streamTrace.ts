import type { MessageStreamEvent } from './api/types.js'

/**
 * Timing of one streamed request, for diagnosing gaps in what the user sees. Times are ms after
 * the request was sent; blocks carry sizes only, never their content.
 */
export type StreamTrace = {
  /** Tool round of the reply this request belongs to (0: the first request). */
  readonly round: number
  /** When the first event arrived (null: none did). */
  readonly firstEventMs: number | null
  readonly blocks: readonly StreamTraceBlock[]
  /** The longest wait between consecutive events (or before the first), and what ended it. */
  readonly longestGap: { readonly ms: number; readonly endedBy: string } | null
  readonly stopReason: string | null
  readonly endMs: number
  /** Set when the stream ended in an error (including an abort). */
  readonly error?: string
}

export type StreamTraceBlock = {
  readonly index: number
  /** Block type, plus the tool name for tool calls (`tool_use:present_file`). */
  readonly type: string
  readonly startMs: number
  readonly firstDeltaMs: number | null
  readonly lastDeltaMs: number | null
  readonly deltas: number
  /** Characters received in deltas. */
  readonly chars: number
  readonly stopMs: number | null
}

type MutableBlock = { -readonly [K in keyof StreamTraceBlock]: StreamTraceBlock[K] }

const deltaChars = (event: Extract<MessageStreamEvent, { type: 'content_block_delta' }>) => {
  const { delta } = event
  switch (delta.type) {
    case 'text_delta':
      return delta.text.length
    case 'thinking_delta':
      return delta.thinking.length
    case 'signature_delta':
      return delta.signature.length
    case 'input_json_delta':
      return delta.partial_json.length
    default:
      return 0
  }
}

/** Records one request's events as they arrive; `finish` returns the trace. */
export const createStreamTracer = (round: number, sentAt: number) => {
  const blocks = new Map<number, MutableBlock>()
  const order: MutableBlock[] = []
  let firstEventMs: number | null = null
  let lastEventMs = 0
  let longestGap: StreamTrace['longestGap'] = null
  let stopReason: string | null = null

  return {
    record: (event: MessageStreamEvent, now: number) => {
      const at = now - sentAt
      firstEventMs ??= at
      const gap = at - lastEventMs
      lastEventMs = at
      const label =
        event.type === 'content_block_start'
          ? `content_block_start ${event.content_block.type}`
          : event.type === 'content_block_delta'
            ? `content_block_delta ${event.delta.type}`
            : event.type
      if (!longestGap || gap > longestGap.ms) {
        longestGap = { ms: gap, endedBy: label }
      }
      if (event.type === 'content_block_start') {
        const start = event.content_block
        const block: MutableBlock = {
          index: event.index,
          type: start.type === 'tool_use' ? `tool_use:${start.name}` : start.type,
          startMs: at,
          firstDeltaMs: null,
          lastDeltaMs: null,
          deltas: 0,
          chars: 0,
          stopMs: null,
        }
        blocks.set(event.index, block)
        order.push(block)
      } else if (event.type === 'content_block_delta') {
        const block = blocks.get(event.index)
        if (block) {
          block.firstDeltaMs ??= at
          block.lastDeltaMs = at
          block.deltas += 1
          block.chars += deltaChars(event)
        }
      } else if (event.type === 'content_block_stop') {
        const block = blocks.get(event.index)
        if (block) {
          block.stopMs = at
        }
      } else if (event.type === 'message_delta') {
        stopReason = event.delta.stop_reason
      }
    },
    finish: (now: number, error?: unknown): StreamTrace => ({
      round,
      firstEventMs,
      blocks: order.map((block) => ({ ...block })),
      longestGap,
      stopReason,
      endMs: now - sentAt,
      ...(error === undefined
        ? {}
        : { error: error instanceof Error ? `${error.name}: ${error.message}` : String(error) }),
    }),
  }
}
