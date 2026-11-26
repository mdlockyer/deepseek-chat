import type {
  MessageStreamEvent,
  MessageUsage,
  MessageUsageDelta,
  OutputBlockStart,
  StopDetails,
  StopReason,
} from './types.js'

export type TranscriptTextBlock = {
  type: 'text'
  text: string
}

export type TranscriptThinkingBlock = {
  type: 'thinking'
  thinking: string
  signature?: string
  startedAt?: number
  endedAt?: number
  elapsedSeconds?: number
}

export type TranscriptToolUseBlock = {
  type: 'tool_use'
  id: string
  name: string
  input: unknown
  inputJson?: string
}

export type Block = TranscriptTextBlock | TranscriptThinkingBlock | TranscriptToolUseBlock

export type Transcript<B extends { type: string } = Block> = {
  blocks: B[]
  stopReason?: StopReason
  stopDetails?: StopDetails
  usage?: MessageUsage
  /** Immutable mapping from the current stream's content_block index to `blocks` index. */
  activeBlocks?: Readonly<Record<number, number>>
}

export const emptyTranscript = (): Transcript => ({ blocks: [] })

const toBlock = (block: OutputBlockStart, now: number): Block | null => {
  switch (block.type) {
    case 'text':
      return { type: 'text', text: block.text }
    case 'thinking':
      return {
        type: 'thinking',
        thinking: block.thinking,
        ...(block.signature !== undefined ? { signature: block.signature } : {}),
        startedAt: now,
      }
    case 'tool_use':
      return { type: 'tool_use', id: block.id, name: block.name, input: {}, inputJson: '' }
    default:
      return null
  }
}

const mergeUsage = (
  previous: MessageUsage | undefined,
  delta: MessageUsageDelta | undefined
): MessageUsage | undefined => {
  if (!delta) {
    return previous
  }
  return {
    input_tokens: delta.input_tokens ?? previous?.input_tokens ?? 0,
    cache_creation_input_tokens:
      delta.cache_creation_input_tokens ?? previous?.cache_creation_input_tokens ?? 0,
    cache_read_input_tokens:
      delta.cache_read_input_tokens ?? previous?.cache_read_input_tokens ?? 0,
    output_tokens: delta.output_tokens ?? previous?.output_tokens ?? 0,
  }
}

const omitIndex = (
  active: Readonly<Record<number, number>> | undefined,
  index: number
): Readonly<Record<number, number>> => {
  if (!active || !(index in active)) {
    return active ?? {}
  }
  const next: Record<number, number> = {}
  for (const [key, value] of Object.entries(active)) {
    if (Number(key) !== index) {
      next[Number(key)] = value
    }
  }
  return next
}

const updateBlockAt = <B extends { type: string }>(
  transcript: Transcript<B>,
  index: number,
  activeBlocks: Readonly<Record<number, number>> | undefined,
  update: (block: Block) => Block
): Transcript<B> => {
  const existing = transcript.blocks[index]
  if (!existing) {
    return activeBlocks === transcript.activeBlocks ? transcript : { ...transcript, activeBlocks }
  }
  const updated = update(existing as unknown as Block) as unknown as B
  const blocks = [...transcript.blocks]
  blocks[index] = updated
  return { ...transcript, blocks, ...(activeBlocks !== undefined ? { activeBlocks } : {}) }
}

/**
 * Pure stream-event reducer: folds one `MessageStreamEvent` into a `Transcript` without mutating
 * the input transcript or any of its blocks.
 */
export const applyEvent = <B extends { type: string } = Block>(
  transcript: Transcript<B>,
  event: MessageStreamEvent,
  now: number
): Transcript<B> => {
  switch (event.type) {
    case 'message_start':
      return {
        ...transcript,
        activeBlocks: {},
        usage: event.message.usage ?? transcript.usage,
      }
    case 'content_block_start': {
      const cleaned = omitIndex(transcript.activeBlocks, event.index)
      const block = toBlock(event.content_block, now)
      if (!block) {
        return { ...transcript, activeBlocks: cleaned }
      }
      const nextActive: Record<number, number> = {
        ...cleaned,
        [event.index]: transcript.blocks.length,
      }
      return {
        ...transcript,
        activeBlocks: nextActive,
        blocks: [...transcript.blocks, block as unknown as B],
      }
    }
    case 'content_block_delta': {
      const index = transcript.activeBlocks?.[event.index]
      if (index === undefined) {
        return transcript
      }
      const { delta } = event
      return updateBlockAt(transcript, index, transcript.activeBlocks, (block) => {
        if (block.type === 'text' && delta.type === 'text_delta') {
          return { ...block, text: block.text + delta.text }
        }
        if (block.type === 'thinking' && delta.type === 'thinking_delta') {
          return { ...block, thinking: block.thinking + delta.thinking }
        }
        if (block.type === 'thinking' && delta.type === 'signature_delta') {
          return { ...block, signature: (block.signature ?? '') + delta.signature }
        }
        if (block.type === 'tool_use' && delta.type === 'input_json_delta') {
          return { ...block, inputJson: (block.inputJson ?? '') + delta.partial_json }
        }
        return block
      })
    }
    case 'content_block_stop': {
      const index = transcript.activeBlocks?.[event.index]
      if (index === undefined) {
        return transcript
      }
      const nextActive = omitIndex(transcript.activeBlocks, event.index)
      return updateBlockAt(transcript, index, nextActive, (block) => {
        if (block.type === 'tool_use') {
          const { inputJson, ...rest } = block
          if (!inputJson?.trim()) {
            return rest
          }
          try {
            return { ...rest, input: JSON.parse(inputJson) as unknown }
          } catch {
            return block
          }
        }
        return block.type === 'thinking' &&
          block.startedAt !== undefined &&
          block.endedAt === undefined
          ? { ...block, endedAt: now }
          : block
      })
    }
    case 'message_delta':
      return {
        ...transcript,
        stopReason: event.delta.stop_reason,
        stopDetails: event.delta.stop_details,
        usage: mergeUsage(transcript.usage, event.usage),
      }
    default:
      return transcript
  }
}
