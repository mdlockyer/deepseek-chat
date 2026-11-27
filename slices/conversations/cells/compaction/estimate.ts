import type { ClientTool, MessageParam, MessageUsage, ModelSpec } from '@deepseek-chat/lib-agent'
import {
  computeCompactionPolicy,
  findActiveCheckpoint,
  getReplyText,
  type AssistantMessage,
  type CompactionCheckpoint,
  type CompactionPolicy,
  type FileAttachment,
  type Message,
  type ReplyBlock,
  type UserMessage,
} from '../../kernel/index.js'

const IMAGE_TOKENS = 1_000
const REMOTE_DOCUMENT_TOKENS = 4_000
const MIN_DOCUMENT_TOKENS = 1_000
const MAX_DOCUMENT_TOKENS = 16_000
const DEFAULT_SYSTEM_OVERHEAD_TOKENS = 1_200

const isCjkOrFullWidth = (code: number): boolean =>
  (code >= 0x3000 && code <= 0x30ff) ||
  (code >= 0x3400 && code <= 0x4dbf) ||
  (code >= 0x4e00 && code <= 0x9fff) ||
  (code >= 0xac00 && code <= 0xd7af) ||
  (code >= 0xf900 && code <= 0xfaff) ||
  (code >= 0xff00 && code <= 0xffef)

/**
 * CJK-aware token estimator: counts CJK/full-width characters at ~1.5 chars/token and
 * Latin/code characters at ~4 chars/token so bilingual Chinese/English chats stay calibrated.
 */
export const estimateTextTokens = (text: string): number => {
  if (!text) {
    return 0
  }
  let cjk = 0
  let other = 0
  for (let i = 0; i < text.length; i += 1) {
    if (isCjkOrFullWidth(text.charCodeAt(i))) {
      cjk += 1
    } else {
      other += 1
    }
  }
  return Math.ceil(cjk / 1.5) + Math.ceil(other / 4)
}

export const estimateAttachmentTokens = (
  file: Pick<FileAttachment, 'isImage' | 'size'>
): number => {
  if (file.isImage) {
    return IMAGE_TOKENS
  }
  const bytes = Math.max(0, file.size)
  return Math.min(MAX_DOCUMENT_TOKENS, Math.max(MIN_DOCUMENT_TOKENS, Math.ceil(bytes / 6)))
}

export const usageTotalTokens = (usage: MessageUsage | undefined): number => {
  if (!usage) {
    return 0
  }
  return (
    Math.max(0, usage.input_tokens) +
    Math.max(0, usage.cache_creation_input_tokens) +
    Math.max(0, usage.cache_read_input_tokens) +
    Math.max(0, usage.output_tokens)
  )
}

const estimateContentBlockTokens = (block: unknown): number => {
  if (!block || typeof block !== 'object') {
    return 0
  }
  const typed = block as Record<string, unknown>
  switch (typed.type) {
    case 'text':
      return estimateTextTokens(typeof typed.text === 'string' ? typed.text : '') + 4
    case 'thinking':
      return estimateTextTokens(typeof typed.thinking === 'string' ? typed.thinking : '') + 4
    case 'tool_use': {
      const name = typeof typed.name === 'string' ? typed.name : ''
      const inputJson = JSON.stringify(typed.input ?? {})
      return estimateTextTokens(name) + estimateTextTokens(inputJson) + 16
    }
    case 'tool_result': {
      const content = typed.content
      if (typeof content === 'string') {
        return estimateTextTokens(content) + 12
      }
      if (Array.isArray(content)) {
        return 12 + content.reduce((sum, item) => sum + estimateContentBlockTokens(item), 0)
      }
      return 12
    }
    case 'image':
      return IMAGE_TOKENS
    case 'document': {
      const source = typed.source as Record<string, unknown> | undefined
      if (source?.type === 'base64' && typeof source.data === 'string') {
        const bytes = Math.floor((source.data.length * 3) / 4)
        return Math.min(MAX_DOCUMENT_TOKENS, Math.max(MIN_DOCUMENT_TOKENS, Math.ceil(bytes / 6)))
      }
      return REMOTE_DOCUMENT_TOKENS
    }
    default:
      return 0
  }
}

/** Local token estimate for a fully serialized Messages API payload (`system`, `tools`, `messages`). */
export const estimateMessagesTokens = (
  messages: readonly MessageParam[],
  system?: string,
  tools?: readonly ClientTool[]
): number => {
  let total = system ? estimateTextTokens(system) + 8 : 0
  if (tools && tools.length > 0) {
    total += estimateTextTokens(JSON.stringify(tools)) + 16
  }
  for (const message of messages) {
    total += 4
    if (typeof message.content === 'string') {
      total += estimateTextTokens(message.content)
    } else if (Array.isArray(message.content)) {
      for (const block of message.content) {
        total += estimateContentBlockTokens(block)
      }
    }
  }
  return total
}

export const estimateReplyBlockTokens = (
  block: ReplyBlock,
  options: { readonly includeThinking?: boolean; readonly includeImages?: boolean } = {}
): number => {
  switch (block.type) {
    case 'text':
      return block.isTemplate ? 0 : estimateTextTokens(block.text) + 4
    case 'thinking':
      return options.includeThinking ? estimateTextTokens(block.thinking) + 4 : 0
    case 'tool_use':
      return (
        estimateTextTokens(block.name) +
        estimateTextTokens(block.inputJson ?? JSON.stringify(block.input ?? {})) +
        16
      )
    case 'tool_result': {
      const imageCount = options.includeImages ? (block.images?.length ?? 0) : 0
      return estimateTextTokens(block.content) + imageCount * IMAGE_TOKENS + 12
    }
  }
}

const estimateUserMessageTokens = (message: UserMessage): number =>
  4 +
  estimateTextTokens(message.content) +
  message.files.reduce((sum, file) => sum + estimateAttachmentTokens(file), 0)

const estimateAssistantMessageTokens = (
  message: AssistantMessage,
  options: {
    readonly includeThinking?: boolean
    readonly includeImages?: boolean
    readonly fromBlockIndex?: number
  } = {}
): number => {
  if (message.stopReason === 'refusal') {
    return 0
  }
  const start = options.fromBlockIndex ?? 0
  let total = 4
  for (let i = start; i < message.blocks.length; i += 1) {
    total += estimateReplyBlockTokens(message.blocks[i], options)
  }
  return total
}

/**
 * Estimates the un-accounted delta on an active `inProgress` reply whose `usage` reflects the most
 * recent completed model round (specifically any trailing `tool_result` blocks added after the last
 * streamed `tool_use` / `text` / `thinking` block).
 */
export const estimateTrailingToolResultDelta = (reply: AssistantMessage): number => {
  let delta = 0
  for (let i = reply.blocks.length - 1; i >= 0; i -= 1) {
    const block = reply.blocks[i]
    if (block.type !== 'tool_result') {
      break
    }
    delta += estimateReplyBlockTokens(block, { includeImages: true })
  }
  return delta
}

export type SessionContextEstimate = {
  readonly tokens: number
  readonly source: 'usage+delta' | 'local'
  readonly policy: CompactionPolicy
  readonly activeCheckpoint: CompactionCheckpoint | null
}

/**
 * Hybrid context estimator shared by both `replyRunner` and the composer context meter:
 * anchors on the newest post-checkpoint `AssistantMessage.usage` when present, adding CJK-aware
 * local estimates for subsequent messages/blocks; falls back to full local estimation otherwise.
 */
export const estimateSessionContext = (params: {
  readonly visibleMessages: readonly Message[]
  readonly checkpoints?: readonly CompactionCheckpoint[]
  readonly modelSpec: ModelSpec
  readonly pendingDraftText?: string
  readonly inProgressReply?: AssistantMessage
  readonly systemOverheadTokens?: number
}): SessionContextEstimate => {
  const {
    visibleMessages,
    checkpoints,
    modelSpec,
    pendingDraftText,
    inProgressReply,
    systemOverheadTokens = DEFAULT_SYSTEM_OVERHEAD_TOKENS,
  } = params
  const policy = computeCompactionPolicy(modelSpec)
  const activeCheckpoint = findActiveCheckpoint(visibleMessages, checkpoints, inProgressReply?.id)

  const anchorIndex = activeCheckpoint
    ? visibleMessages.findIndex((message) => message.id === activeCheckpoint.anchorMessageId)
    : -1

  // Determine the post-checkpoint visible slice.
  const sliceStart = activeCheckpoint
    ? anchorIndex >= 0
      ? activeCheckpoint.afterBlockIndex !== undefined
        ? anchorIndex
        : anchorIndex + 1
      : visibleMessages.length
    : 0

  const draftTokens = pendingDraftText ? estimateTextTokens(pendingDraftText) : 0

  // Check if `inProgressReply` itself has fresh post-checkpoint server usage.
  if (inProgressReply) {
    const isMidTurnAnchor =
      activeCheckpoint !== null &&
      activeCheckpoint.anchorMessageId === inProgressReply.id &&
      activeCheckpoint.afterBlockIndex !== undefined
    const hasPostCheckpointRound =
      !isMidTurnAnchor ||
      inProgressReply.blocks.length - 1 > (activeCheckpoint.afterBlockIndex ?? -1)
    const inProgressUsage = hasPostCheckpointRound ? usageTotalTokens(inProgressReply.usage) : 0
    if (inProgressUsage > 0) {
      return {
        tokens: inProgressUsage + estimateTrailingToolResultDelta(inProgressReply) + draftTokens,
        source: 'usage+delta',
        policy,
        activeCheckpoint,
      }
    }
  }

  // Otherwise locate the newest post-checkpoint assistant reply in `visibleMessages` with real usage.
  let usageAnchorIndex = -1
  let usageBase = 0
  for (let i = visibleMessages.length - 1; i >= sliceStart; i -= 1) {
    const message = visibleMessages[i]
    if (message.role !== 'assistant') {
      continue
    }
    if (
      activeCheckpoint &&
      message.id === activeCheckpoint.anchorMessageId &&
      activeCheckpoint.afterBlockIndex !== undefined &&
      message.blocks.length - 1 <= activeCheckpoint.afterBlockIndex
    ) {
      continue
    }
    const total = usageTotalTokens(message.usage)
    if (total > 0) {
      usageAnchorIndex = i
      usageBase = total
      break
    }
  }

  if (usageAnchorIndex >= 0) {
    let delta = draftTokens
    const usageReply = visibleMessages[usageAnchorIndex]
    if (usageReply.role === 'assistant') {
      delta += estimateTrailingToolResultDelta(usageReply)
    }
    for (let i = usageAnchorIndex + 1; i < visibleMessages.length; i += 1) {
      const msg = visibleMessages[i]
      delta +=
        msg.role === 'user'
          ? estimateUserMessageTokens(msg)
          : estimateAssistantMessageTokens(msg, { includeThinking: false, includeImages: false })
    }
    if (inProgressReply && !visibleMessages.some((m) => m.id === inProgressReply.id)) {
      delta += estimateAssistantMessageTokens(inProgressReply, {
        includeThinking: true,
        includeImages: true,
      })
    }
    return {
      tokens: usageBase + delta,
      source: 'usage+delta',
      policy,
      activeCheckpoint,
    }
  }

  // Pure local fallback (no post-checkpoint server usage recorded yet).
  let localTokens = activeCheckpoint
    ? estimateTextTokens(activeCheckpoint.renderedWireText) + systemOverheadTokens
    : visibleMessages.length > 0 || inProgressReply
      ? systemOverheadTokens
      : 0

  for (let i = sliceStart; i < visibleMessages.length; i += 1) {
    const msg = visibleMessages[i]
    if (msg.role === 'user') {
      localTokens += estimateUserMessageTokens(msg)
    } else {
      const isMidTurnAnchor =
        activeCheckpoint !== null &&
        msg.id === activeCheckpoint.anchorMessageId &&
        activeCheckpoint.afterBlockIndex !== undefined
      const fromBlockIndex = isMidTurnAnchor ? (activeCheckpoint.afterBlockIndex ?? -1) + 1 : 0
      localTokens += estimateAssistantMessageTokens(msg, {
        includeThinking: false,
        includeImages: false,
        fromBlockIndex,
      })
    }
  }

  if (inProgressReply && !visibleMessages.some((m) => m.id === inProgressReply.id)) {
    const isMidTurnAnchor =
      activeCheckpoint !== null &&
      activeCheckpoint.anchorMessageId === inProgressReply.id &&
      activeCheckpoint.afterBlockIndex !== undefined
    const fromBlockIndex = isMidTurnAnchor ? (activeCheckpoint.afterBlockIndex ?? -1) + 1 : 0
    localTokens += estimateAssistantMessageTokens(inProgressReply, {
      includeThinking: true,
      includeImages: true,
      fromBlockIndex,
    })
  }

  return {
    tokens: localTokens + draftTokens,
    source: 'local',
    policy,
    activeCheckpoint,
  }
}

/** True when a reply contains non-empty usable assistant prose. */
export const hasCompactableText = (message: AssistantMessage): boolean =>
  (message.status === 'done' || message.status === 'stopped') &&
  message.stopReason !== 'refusal' &&
  !message.blocks.some((block) => block.type === 'text' && block.isTemplate) &&
  getReplyText(message).trim() !== ''
