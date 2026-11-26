import {
  applyEvent as applyAgentEvent,
  type AssistantBlockParam,
  type FileBlockParam,
  type MessageParam,
  type MessageStreamEvent,
  type ProviderId,
  type TextBlockParam,
  type ToolResultBlockParam,
} from '@deepseek-chat/lib-agent'
import { resolveEnvironmentContext } from './environmentContext.js'
import type {
  AssistantMessage,
  FileAttachment,
  Message,
  ReplyBlock,
  ReplyStatus,
  UserMessage,
} from './types.js'

/** Pre-encoded base64 attachment payload used when the active provider does not use remote file IDs. */
export type InlineAttachmentData = {
  readonly mediaType: string
  readonly base64: string
}

/**
 * Standard user-role continuation prompt replacing non-portable assistant prefill when continuing
 * a stopped or `max_tokens`-truncated prose reply.
 */
export const CONTINUE_PROMPT =
  '[System note: Your previous response stopped before finishing. Continue seamlessly from where you left off without repeating text you already wrote.]'

const parseDataUrl = (dataUrl: string): InlineAttachmentData | null => {
  const comma = dataUrl.indexOf(',')
  if (comma === -1) {
    return null
  }
  const header = dataUrl.slice(0, comma)
  const data = dataUrl.slice(comma + 1)
  if (!data) {
    return null
  }
  const mediaType = /data:([^;]+)/.exec(header)?.[1] ?? 'image/jpeg'
  return { mediaType, base64: data }
}

const serverIdForProvider = (file: FileAttachment, providerId?: ProviderId): string | null => {
  if (!file.serverId) {
    return null
  }
  if (!providerId) {
    return file.serverId
  }
  const owner = file.serverProvider ?? 'deepseek'
  return owner === providerId ? file.serverId : null
}

const toFileBlocks = (
  files: FileAttachment[],
  providerId?: ProviderId,
  inlineBlobs?: ReadonlyMap<string, InlineAttachmentData>
): FileBlockParam[] =>
  files.flatMap((file): FileBlockParam[] => {
    const remoteId = serverIdForProvider(file, providerId)
    if (remoteId) {
      return [
        {
          type: file.isImage ? 'image' : 'document',
          source: { type: 'file', file_id: remoteId },
        },
      ]
    }
    const inline = inlineBlobs?.get(file.id)
    if (inline) {
      return [
        {
          type: file.isImage ? 'image' : 'document',
          source: { type: 'base64', media_type: inline.mediaType, data: inline.base64 },
        },
      ]
    }
    return []
  })

/** Merges one stream event into a reply without mutating prior objects. */
export const applyEvent = (
  reply: AssistantMessage,
  event: MessageStreamEvent,
  now: number,
  blockIndexes: Map<number, number>
): AssistantMessage => {
  const activeBlocks: Record<number, number> = {}
  for (const [streamIdx, blockIdx] of blockIndexes) {
    activeBlocks[streamIdx] = blockIdx
  }
  const nextTranscript = applyAgentEvent(
    {
      blocks: reply.blocks,
      stopReason: reply.stopReason,
      stopDetails: reply.stopDetails,
      usage: reply.usage,
      activeBlocks,
    },
    event,
    now
  )
  blockIndexes.clear()
  if (nextTranscript.activeBlocks) {
    for (const [streamIdx, blockIdx] of Object.entries(nextTranscript.activeBlocks)) {
      blockIndexes.set(Number(streamIdx), blockIdx)
    }
  }
  return {
    ...reply,
    status: 'streaming',
    blocks: nextTranscript.blocks,
    stopReason: nextTranscript.stopReason,
    stopDetails: nextTranscript.stopDetails,
    usage: nextTranscript.usage,
  }
}

/** Finalizes a reply, closing any open thinking block and dropping refusal text/thinking per protocol. */
export const settleReply = (
  reply: AssistantMessage,
  status: Extract<ReplyStatus, 'done' | 'stopped' | 'error'>,
  now: number,
  error?: AssistantMessage['error']
): AssistantMessage => ({
  ...reply,
  status,
  error,
  blocks: reply.blocks.flatMap((block): ReplyBlock[] => {
    if (reply.stopReason === 'refusal' && (block.type === 'thinking' || block.type === 'text')) {
      return []
    }
    return block.type === 'thinking' && block.startedAt !== undefined && block.endedAt === undefined
      ? [{ ...block, endedAt: now }]
      : [block]
  }),
})

export const getReplyText = (reply: AssistantMessage) =>
  reply.blocks.map((block) => (block.type === 'text' ? block.text : '')).join('')

const lastToolIndex = (reply: AssistantMessage) =>
  reply.blocks.findLastIndex((block) => block.type === 'tool_use' || block.type === 'tool_result')

/**
 * True when an interrupted or unfinished tool loop can resume by executing unanswered tool calls
 * and sending the resulting `tool_result` user message.
 */
export const canResumeToolLoop = (reply: AssistantMessage): boolean => {
  if (
    lastToolIndex(reply) === -1 ||
    reply.stopReason === 'refusal' ||
    reply.error?.kind === 'upload'
  ) {
    return false
  }
  if (reply.status === 'error' || reply.status === 'stopped') {
    return true
  }
  if (reply.status !== 'done') {
    return false
  }
  const answered = new Set(
    reply.blocks.flatMap((block) =>
      block.type === 'tool_result' && block.status !== 'running' ? [block.tool_use_id] : []
    )
  )
  return reply.blocks.some((block) => block.type === 'tool_use' && !answered.has(block.id))
}

/** Drops trailing partial blocks after the last tool block and removes any `running` results. */
export const trimAfterLastToolResult = (reply: AssistantMessage): AssistantMessage => {
  const last = lastToolIndex(reply)
  if (last === -1) {
    return reply
  }
  return {
    ...reply,
    blocks: reply.blocks
      .slice(0, last + 1)
      .filter((block) => block.type !== 'tool_result' || block.status !== 'running'),
  }
}

/**
 * True when a reply can either resume its tool loop or continue a stopped / `max_tokens`-truncated
 * text response via a standard user continuation prompt.
 */
export const canContinueReply = (reply: AssistantMessage): boolean => {
  if (canResumeToolLoop(reply)) {
    return true
  }
  if (
    reply.stopReason === 'refusal' ||
    reply.stopReason === 'tool_use' ||
    reply.blocks.some((block) => block.type === 'text' && block.isTemplate) ||
    !getReplyText(reply).trim()
  ) {
    return false
  }
  return (
    reply.status === 'stopped' || (reply.status === 'done' && reply.stopReason === 'max_tokens')
  )
}

const isUsableReply = (message: Message): message is AssistantMessage =>
  message.role === 'assistant' &&
  (message.status === 'done' || message.status === 'stopped') &&
  message.stopReason !== 'refusal' &&
  !message.blocks.some((block) => block.type === 'text' && block.isTemplate) &&
  getReplyText(message) !== ''

const toUserParam = (
  { content, files }: UserMessage,
  envPrefix: string | undefined,
  providerId?: ProviderId,
  inlineBlobs?: ReadonlyMap<string, InlineAttachmentData>
): Extract<MessageParam, { role: 'user' }> => {
  const blocks = toFileBlocks(files, providerId, inlineBlobs)
  if (blocks.length === 0) {
    const text = envPrefix ? (content ? `${envPrefix}\n\n${content}` : envPrefix) : content
    return { role: 'user', content: text }
  }
  return {
    role: 'user',
    content: [
      ...(envPrefix ? [{ type: 'text' as const, text: envPrefix }] : []),
      ...blocks,
      ...(content ? [{ type: 'text' as const, text: content }] : []),
    ],
  }
}

const IMAGE_BUDGET_COUNT = 12

type ToolResult = Extract<ReplyBlock, { type: 'tool_result' }>

/** Selects the newest tool-result image batches that fit within the 12-image budget. */
export const pickImageResults = (blocks: ReplyBlock[]): ToolResult[] => {
  const picked: ToolResult[] = []
  let count = 0
  for (const block of [...blocks].reverse()) {
    if (block.type !== 'tool_result' || !block.images?.length) {
      continue
    }
    if (count + block.images.length > IMAGE_BUDGET_COUNT) {
      break
    }
    count += block.images.length
    picked.push(block)
  }
  return picked
}

const plural = (count: number, one: string, many: string) => (count === 1 ? one : many)

const toToolResultText = (block: ToolResult, attached: number): string => {
  const count = block.images?.length ?? 0
  if (count === 0) {
    return block.content
  }
  if (attached === 0) {
    return `${block.content}\n[The ${count} ${plural(count, 'image is', 'images are')} no longer attached; re-run the tool with image output enabled to see ${plural(count, 'it', 'them')}.]`
  }
  const failed = count - attached
  return `${block.content}\n[${attached} ${plural(attached, 'image', 'images')} from this call ${plural(attached, 'follows', 'follow')} the tool results${failed ? `; ${failed} could not be uploaded` : ''}.]`
}

const toImageBlocks = (
  block: ToolResult,
  inlineImages: boolean
): (TextBlockParam | FileBlockParam)[] => {
  if (inlineImages) {
    const parsed = (block.images ?? [])
      .map(parseDataUrl)
      .filter((item): item is InlineAttachmentData => item !== null)
    return parsed.length === 0
      ? []
      : [
          { type: 'text', text: `Images from tool call ${block.tool_use_id}:` },
          ...parsed.map(
            (item): FileBlockParam => ({
              type: 'image',
              source: { type: 'base64', media_type: item.mediaType, data: item.base64 },
            })
          ),
        ]
  }
  const ids = (block.imageFileIds ?? []).filter((id): id is string => !!id)
  return ids.length === 0
    ? []
    : [
        { type: 'text', text: `Images from tool call ${block.tool_use_id}:` },
        ...ids.map(
          (id): FileBlockParam => ({ type: 'image', source: { type: 'file', file_id: id } })
        ),
      ]
}

const toAssistantMessages = (
  { blocks }: AssistantMessage,
  options: {
    readonly includeThinking?: boolean
    readonly includeImages?: boolean
    readonly inlineImages?: boolean
    readonly clientTools?: boolean | ReadonlySet<string>
  } = {}
): MessageParam[] => {
  const includeThinking = options.includeThinking ?? false
  const includeImages = options.includeImages ?? false
  const inlineImages = options.inlineImages ?? false
  const clientTools = options.clientTools ?? true

  const imageResults = new Set(includeImages ? pickImageResults(blocks) : [])
  const isDeclaredTool = (name: string) =>
    typeof clientTools === 'boolean' ? clientTools : clientTools.has(name)
  const declaredToolIds = new Set(
    blocks.flatMap((block) =>
      block.type === 'tool_use' && isDeclaredTool(block.name) ? [block.id] : []
    )
  )
  const answered = new Set(
    blocks.flatMap((block) =>
      block.type === 'tool_result' &&
      block.status !== 'running' &&
      declaredToolIds.has(block.tool_use_id)
        ? [block.tool_use_id]
        : []
    )
  )

  const messages: MessageParam[] = []
  let content: AssistantBlockParam[] = []
  let results: ToolResultBlockParam[] = []
  let images: (TextBlockParam | FileBlockParam)[] = []

  const pushResults = () => {
    messages.push({ role: 'user', content: [...results, ...images] })
    results = []
    images = []
  }

  let text: TextBlockParam | null = null
  const pushAssistant = () => {
    const filtered = content.filter((block) => block.type !== 'text' || block.text !== '')
    if (filtered.length > 0) {
      messages.push({ role: 'assistant', content: filtered })
    }
    content = []
  }

  for (const block of blocks) {
    if (block.type === 'tool_use' && !isDeclaredTool(block.name)) {
      continue
    }
    if (block.type === 'tool_result') {
      if (!declaredToolIds.has(block.tool_use_id)) {
        continue
      }
      text = null
      if (answered.has(block.tool_use_id)) {
        const attached = imageResults.has(block) ? toImageBlocks(block, inlineImages) : []
        results.push({
          type: 'tool_result',
          tool_use_id: block.tool_use_id,
          content: toToolResultText(block, attached.filter((item) => item.type === 'image').length),
        })
        images.push(...attached)
      }
      continue
    }
    if (results.length > 0) {
      pushAssistant()
      pushResults()
    }
    if (block.type === 'text') {
      if (text) {
        text.text += block.text
      } else {
        const previous = content.at(-1)
        text = {
          type: 'text',
          text: `${previous?.type === 'text' ? '\n\n' : ''}${block.text}`,
        }
        content.push(text)
      }
      continue
    }
    text = null
    if (block.type === 'thinking' && includeThinking) {
      if (block.thinking.trim() || block.signature) {
        content.push({
          type: 'thinking',
          thinking: block.thinking,
          ...(block.signature !== undefined ? { signature: block.signature } : {}),
        })
      }
    } else if (block.type === 'tool_use') {
      if (answered.has(block.id)) {
        const { type, id, name, input } = block
        content.push({ type, id, name, input })
      }
    }
  }
  pushAssistant()
  if (results.length > 0) {
    pushResults()
  }
  return messages
}

export const getContextRounds = (history: Message[]): [UserMessage, AssistantMessage][] => {
  const rounds: [UserMessage, AssistantMessage][] = []
  for (let i = 0; i + 1 < history.length; i++) {
    const [user, reply] = [history[i], history[i + 1]]
    if (user.role === 'user' && isUsableReply(reply)) {
      rounds.push([user, reply])
      i++
    }
  }
  return rounds
}

export type ToRequestMessagesOptions = {
  /** Existing stopped or max-token prose reply being continued via a standard user prompt. */
  readonly continueReply?: AssistantMessage
  /** Dynamic `<environment_context>` for the current turn (prepended only when changed). */
  readonly environmentContext?: string
  /** In-progress tool-loop reply whose tool calls and results follow the current question. */
  readonly inProgress?: AssistantMessage
  /** Whether to replay `thinking` blocks on `inProgress` (true only when provider+model match). */
  readonly includeInProgressThinking?: boolean
  /** Declared client tools for this request. */
  readonly clientTools?: boolean | ReadonlySet<string>
  /** Active provider ID for matching cached `file.serverId` remote references. */
  readonly providerId?: ProviderId
  /** Base64 payloads keyed by `FileAttachment.id` for inline-attachment providers. */
  readonly inlineBlobs?: ReadonlyMap<string, InlineAttachmentData>
  /** True when tool-output screenshots should travel as inline base64 rather than remote file IDs. */
  readonly inlineToolImages?: boolean
}

/**
 * Serializes conversation history + current turn into strictly standard `user` / `assistant`
 * Messages API entries:
 * - Dynamic `<environment_context>` is prepended to a `user` turn only when it first appears or
 *   changes (preserving KV-cache prefixes without proprietary roles).
 * - Historical completed turns never replay `thinking` blocks; only an active `inProgress` tool
 *   loop replays `thinking` (when `includeInProgressThinking` is true).
 * - Continuing a stopped / `max_tokens` prose reply emits the partial assistant reply followed by
 *   a standard `user` continuation prompt (never assistant prefill).
 */
export const toRequestMessages = (
  history: Message[],
  question: UserMessage,
  options: ToRequestMessagesOptions = {}
): MessageParam[] => {
  const {
    continueReply,
    environmentContext,
    inProgress,
    includeInProgressThinking = false,
    clientTools = true,
    providerId,
    inlineBlobs,
    inlineToolImages = false,
  } = options

  const messages: MessageParam[] = []
  const pushUser = (param: Extract<MessageParam, { role: 'user' }>) => {
    const last = messages.at(-1)
    if (last?.role === 'user') {
      const prevBlocks =
        typeof last.content === 'string'
          ? [{ type: 'text' as const, text: last.content }]
          : last.content
      const extra =
        typeof param.content === 'string'
          ? [{ type: 'text' as const, text: param.content }]
          : param.content
      last.content = [...prevBlocks, ...extra]
    } else {
      messages.push(param)
    }
  }

  let previousEnv: string | undefined
  const nextEnvPrefix = (env: string | undefined): string | undefined => {
    if (env && env !== previousEnv) {
      previousEnv = env
      return env
    }
    return undefined
  }

  for (const [user, reply] of getContextRounds(history)) {
    if (!user.content && toFileBlocks(user.files, providerId, inlineBlobs).length === 0) {
      continue
    }
    const envPrefix = nextEnvPrefix(resolveEnvironmentContext(reply))
    pushUser(toUserParam(user, envPrefix, providerId, inlineBlobs))
    messages.push(
      ...toAssistantMessages(reply, {
        includeThinking: false,
        includeImages: false,
        clientTools,
      })
    )
  }

  const currentEnvPrefix = nextEnvPrefix(environmentContext)
  pushUser(toUserParam(question, currentEnvPrefix, providerId, inlineBlobs))

  if (inProgress) {
    messages.push(
      ...toAssistantMessages(inProgress, {
        includeThinking: includeInProgressThinking,
        includeImages: true,
        inlineImages: inlineToolImages,
        clientTools: true,
      })
    )
    return messages
  }

  if (continueReply) {
    const partial = toAssistantMessages(continueReply, {
      includeThinking: false,
      includeImages: false,
      clientTools,
    })
    if (partial.length > 0) {
      messages.push(...partial)
      pushUser({ role: 'user', content: CONTINUE_PROMPT })
    }
  }

  return messages
}

export const getThinkingSeconds = (startedAt: number, endedAt: number) =>
  Math.max(1, Math.round((endedAt - startedAt) / 1000))
