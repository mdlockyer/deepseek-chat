import type {
  ContentBlockDelta,
  MessageStreamEvent,
  MessageUsage,
  MessageUsageDelta,
  OutputBlockStart,
} from './types.js'

const isRecord = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === 'object' && !Array.isArray(value)

const isString = (value: unknown): value is string => typeof value === 'string'
const isFiniteNumber = (value: unknown): value is number =>
  typeof value === 'number' && Number.isFinite(value)
const isIndex = (value: unknown) => Number.isSafeInteger(value) && (value as number) >= 0

const readBlock = (value: unknown): OutputBlockStart | null => {
  if (!isRecord(value)) {
    return null
  }
  switch (value.type) {
    case 'text':
      if (!isString(value.text)) {
        return null
      }
      return { type: 'text', text: value.text }
    case 'thinking':
      if (!isString(value.thinking)) {
        return null
      }
      return {
        type: 'thinking',
        thinking: value.thinking,
        ...(isString(value.signature) ? { signature: value.signature } : {}),
      }
    case 'tool_use':
      if (!isString(value.id) || !isString(value.name)) {
        return null
      }
      return {
        type: 'tool_use',
        id: value.id,
        name: value.name,
        input: value.input ?? {},
      }
    default:
      return null
  }
}

const readDelta = (value: unknown): ContentBlockDelta | null => {
  if (!isRecord(value)) {
    return null
  }
  switch (value.type) {
    case 'text_delta':
      return isString(value.text) ? { type: 'text_delta', text: value.text } : null
    case 'thinking_delta':
      return isString(value.thinking) ? { type: 'thinking_delta', thinking: value.thinking } : null
    case 'signature_delta':
      return isString(value.signature)
        ? { type: 'signature_delta', signature: value.signature }
        : null
    case 'input_json_delta':
      return isString(value.partial_json)
        ? { type: 'input_json_delta', partial_json: value.partial_json }
        : null
    default:
      return null
  }
}

/**
 * Parses `message_start.message.usage`. Requires at least a finite `input_tokens`; optional cache
 * counters and `output_tokens` default to 0 so standard Anthropic and OpenAI-bridged streams work
 * alongside DeepSeek.
 */
const readStartUsage = (value: unknown): MessageUsage | undefined => {
  if (!isRecord(value) || !isFiniteNumber(value.input_tokens)) {
    return undefined
  }
  return {
    input_tokens: value.input_tokens,
    cache_creation_input_tokens: isFiniteNumber(value.cache_creation_input_tokens)
      ? value.cache_creation_input_tokens
      : 0,
    cache_read_input_tokens: isFiniteNumber(value.cache_read_input_tokens)
      ? value.cache_read_input_tokens
      : 0,
    output_tokens: isFiniteNumber(value.output_tokens) ? value.output_tokens : 0,
  }
}

/**
 * Parses `message_delta.usage`, allowing partial updates (e.g. Anthropic emits only `output_tokens`
 * on `message_delta` while DeepSeek sends all four counters).
 */
const readDeltaUsage = (value: unknown): MessageUsageDelta | undefined => {
  if (!isRecord(value)) {
    return undefined
  }
  const out: { -readonly [K in keyof MessageUsage]?: number } = {}
  if (isFiniteNumber(value.input_tokens)) {
    out.input_tokens = value.input_tokens
  }
  if (isFiniteNumber(value.cache_creation_input_tokens)) {
    out.cache_creation_input_tokens = value.cache_creation_input_tokens
  }
  if (isFiniteNumber(value.cache_read_input_tokens)) {
    out.cache_read_input_tokens = value.cache_read_input_tokens
  }
  if (isFiniteNumber(value.output_tokens)) {
    out.output_tokens = value.output_tokens
  }
  return Object.keys(out).length > 0 ? out : undefined
}

/** Drops unrecognised or malformed events cleanly without interrupting the stream. */
export const readMessageEvent = (value: unknown): MessageStreamEvent | null => {
  if (!isRecord(value)) {
    return null
  }
  switch (value.type) {
    case 'message_start':
      if (!isRecord(value.message)) {
        return null
      }
      return {
        type: 'message_start',
        message: {
          id: isString(value.message.id) ? value.message.id : '',
          model: isString(value.message.model) ? value.message.model : '',
          usage: readStartUsage(value.message.usage),
        },
      }
    case 'content_block_start': {
      const block = readBlock(value.content_block)
      return isIndex(value.index) && block
        ? { type: 'content_block_start', index: value.index as number, content_block: block }
        : null
    }
    case 'content_block_delta': {
      const delta = readDelta(value.delta)
      return isIndex(value.index) && delta
        ? { type: 'content_block_delta', index: value.index as number, delta }
        : null
    }
    case 'content_block_stop':
      if (!isIndex(value.index)) {
        return null
      }
      return { type: 'content_block_stop', index: value.index as number }
    case 'message_delta':
      if (
        !isRecord(value.delta) ||
        !['end_turn', 'max_tokens', 'tool_use', 'refusal'].includes(
          value.delta.stop_reason as string
        )
      ) {
        return null
      }
      return {
        type: 'message_delta',
        delta: {
          stop_reason: value.delta.stop_reason as
            | 'end_turn'
            | 'max_tokens'
            | 'tool_use'
            | 'refusal',
          stop_sequence: null,
          ...(isRecord(value.delta.stop_details) && value.delta.stop_details.type === 'refusal'
            ? { stop_details: { type: 'refusal' as const, category: null, explanation: null } }
            : {}),
        },
        usage: readDeltaUsage(value.usage),
      }
    case 'message_stop':
      return { type: 'message_stop' }
    case 'ping':
      return { type: 'ping' }
    default:
      return null
  }
}
