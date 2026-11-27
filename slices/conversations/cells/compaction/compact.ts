import {
  emptyTranscript,
  applyEvent as applyAgentEvent,
  type ChatModel,
  type ClientTool,
  type MessageParam,
  type ModelProvider,
  type ProviderId,
} from '@deepseek-chat/lib-agent'
import type { ToolRegistry } from '@deepseek-chat/lib-tools'
import {
  getContextRounds,
  toHistoryPrefixMessages,
  toRequestMessages,
  type AssistantMessage,
  type CompactionCheckpoint,
  type CompactionPolicy,
  type CompactionTrigger,
  type InlineAttachmentData,
  type Message,
  type ReplyBlock,
  type UserMessage,
} from '../../kernel/index.js'
import { estimateMessagesTokens, estimateTextTokens } from './estimate.js'
import { buildCompactionLedgerText } from './ledger.js'
import {
  buildChunkedCompactionPrompt,
  buildCompactionInstruction,
  renderCheckpointWireText,
  validateCompactionSummary,
} from './prompts.js'
import { buildVerbatimSection } from './verbatim.js'

const SUMMARY_MAX_OUTPUT_TOKENS = 4_096
const MAX_CHUNK_COUNT = 16
const MAX_CHUNK_HALVINGS = 4
const MAX_CHUNK_TOOL_OUTPUT_CHARS = 4_000

export type CompactionResult =
  | { readonly kind: 'compacted'; readonly checkpoint: CompactionCheckpoint }
  | { readonly kind: 'notNeeded'; readonly reason: 'noHistory' }
  | { readonly kind: 'cancelled' }
  | { readonly kind: 'failed'; readonly reason: string; readonly originalError?: unknown }

export type RunCompactionParams = {
  readonly provider: ModelProvider
  readonly toolRegistry: ToolRegistry
  readonly trigger: CompactionTrigger
  readonly model: ChatModel
  readonly system: string
  readonly tools: readonly ClientTool[]
  readonly history: readonly Message[]
  readonly pendingQuestion?: UserMessage
  readonly inProgressReply?: AssistantMessage
  readonly priorCheckpoint?: CompactionCheckpoint
  readonly declaredClientNames: ReadonlySet<string>
  readonly providerId: ProviderId
  readonly inlineBlobs?: ReadonlyMap<string, InlineAttachmentData>
  readonly inlineToolImages: boolean
  readonly environmentContext?: string
  readonly includeInProgressThinking: boolean
  readonly tokensBefore: number
  readonly policy: CompactionPolicy
  readonly signal: AbortSignal
  readonly newId: () => string
  readonly now?: () => number
}

const isContextLimitError = (provider: ModelProvider, error: unknown): boolean => {
  const condition = provider.classifyError(error)
  return condition === 'contextOverflow' || condition === 'payloadTooLarge'
}

const appendUserInstruction = (
  messages: readonly MessageParam[],
  instruction: string
): MessageParam[] => {
  if (messages.length === 0) {
    return [{ role: 'user', content: instruction }]
  }
  const cloned = messages.map((msg) =>
    msg.role === 'user' && Array.isArray(msg.content)
      ? { role: 'user' as const, content: [...msg.content] }
      : msg
  )
  const last = cloned.at(-1)
  if (last?.role === 'user') {
    const existingBlocks =
      typeof last.content === 'string'
        ? [{ type: 'text' as const, text: last.content }]
        : last.content
    cloned[cloned.length - 1] = {
      role: 'user',
      content: [...existingBlocks, { type: 'text', text: instruction }],
    }
    return cloned
  }
  cloned.push({ role: 'user', content: instruction })
  return cloned
}

type StreamSummaryOutcome =
  | { readonly kind: 'ok'; readonly summary: string }
  | { readonly kind: 'cancelled' }
  | { readonly kind: 'overflow'; readonly error: unknown }
  | { readonly kind: 'failed'; readonly reason: string; readonly error?: unknown }

const streamSummaryOnce = async (
  provider: ModelProvider,
  request: {
    readonly model: ChatModel
    readonly system: string
    readonly messages: readonly MessageParam[]
    readonly tools: readonly ClientTool[]
  },
  signal: AbortSignal
): Promise<StreamSummaryOutcome> => {
  const localAbort = new AbortController()
  const onParentAbort = () => localAbort.abort(signal.reason)
  if (signal.aborted) {
    return { kind: 'cancelled' }
  }
  signal.addEventListener('abort', onParentAbort, { once: true })

  let sawToolUse = false
  let transcript = emptyTranscript()
  try {
    for await (const event of provider.streamMessage(
      {
        model: request.model,
        system: request.system,
        messages: [...request.messages],
        thinking: { type: 'disabled' },
        max_tokens: SUMMARY_MAX_OUTPUT_TOKENS,
        tools: [...request.tools],
      },
      localAbort.signal
    )) {
      if (event.type === 'content_block_start' && event.content_block.type === 'tool_use') {
        sawToolUse = true
        localAbort.abort()
        break
      }
      transcript = applyAgentEvent(transcript, event, Date.now())
    }
  } catch (error) {
    if (signal.aborted) {
      return { kind: 'cancelled' }
    }
    if (sawToolUse) {
      return { kind: 'failed', reason: 'Model attempted a tool call during compaction.' }
    }
    if (isContextLimitError(provider, error)) {
      return { kind: 'overflow', error }
    }
    return {
      kind: 'failed',
      reason: error instanceof Error ? error.message : String(error),
      error,
    }
  } finally {
    signal.removeEventListener('abort', onParentAbort)
  }

  if (signal.aborted) {
    return { kind: 'cancelled' }
  }
  if (sawToolUse) {
    return { kind: 'failed', reason: 'Model attempted a tool call during compaction.' }
  }
  if (transcript.stopReason === 'max_tokens') {
    return { kind: 'failed', reason: 'Compaction summary was truncated at max_tokens.' }
  }
  if (transcript.stopReason === 'refusal') {
    return { kind: 'failed', reason: 'Model refused to generate compaction summary.' }
  }

  const rawText = transcript.blocks
    .map((block) => (block.type === 'text' ? block.text : ''))
    .join('')
  const validation = validateCompactionSummary(rawText)
  if (!validation.ok) {
    return { kind: 'failed', reason: validation.reason }
  }
  return { kind: 'ok', summary: validation.summary }
}

const serializeBlocksForChunk = (blocks: readonly ReplyBlock[]): string => {
  const parts: string[] = []
  for (const block of blocks) {
    if (block.type === 'text' && !block.isTemplate && block.text.trim()) {
      parts.push(block.text.trim())
    } else if (block.type === 'tool_use') {
      const input = (block.inputJson ?? JSON.stringify(block.input ?? {})).slice(0, 600)
      parts.push(`[Tool call ${block.name}: ${input}]`)
    } else if (block.type === 'tool_result' && block.status !== 'running') {
      const snippet =
        block.content.length > MAX_CHUNK_TOOL_OUTPUT_CHARS
          ? `${block.content.slice(0, MAX_CHUNK_TOOL_OUTPUT_CHARS)}\n[... output truncated ...]`
          : block.content
      const imageNote =
        block.images && block.images.length > 0
          ? `\n[Omitted ${block.images.length} tool ${block.images.length === 1 ? 'image' : 'images'}]`
          : ''
      parts.push(`[Tool result (${block.status}): ${snippet}${imageNote}]`)
    }
  }
  return parts.join('\n')
}

const serializeMessageForChunk = (message: Message): string | null => {
  if (message.role === 'user') {
    const lines: string[] = []
    for (const file of message.files) {
      lines.push(file.isImage ? `[Attached image: ${file.name}]` : `[Attached file: ${file.name}]`)
    }
    if (message.content.trim()) {
      lines.push(message.content.trim())
    }
    return lines.length > 0 ? `[User]\n${lines.join('\n')}` : null
  }
  if (message.stopReason === 'refusal') {
    return null
  }
  const body = serializeBlocksForChunk(message.blocks)
  return body ? `[Assistant]\n${body}` : null
}

const splitOversizedEntry = (text: string, maxTokens: number): string[] => {
  if (estimateTextTokens(text) <= maxTokens) {
    return [text]
  }
  const approxChars = Math.max(400, Math.floor(maxTokens * 1.5))
  const pieces: string[] = []
  let offset = 0
  while (offset < text.length) {
    let end = Math.min(text.length, offset + approxChars)
    if (end < text.length) {
      const nl = text.lastIndexOf('\n', end)
      if (nl > offset + Math.floor(approxChars * 0.5)) {
        end = nl + 1
      }
    }
    pieces.push(text.slice(offset, end))
    offset = end
  }
  return pieces
}

const buildPlainTextChunks = (entries: readonly string[], targetChunkTokens: number): string[] => {
  const expanded = entries.flatMap((entry) => splitOversizedEntry(entry, targetChunkTokens))
  const chunks: string[] = []
  let current: string[] = []
  let currentTokens = 0

  for (const entry of expanded) {
    const tokens = estimateTextTokens(entry) + 8
    if (current.length > 0 && currentTokens + tokens > targetChunkTokens) {
      chunks.push(current.join('\n\n'))
      current = [entry]
      currentTokens = tokens
    } else {
      current.push(entry)
      currentTokens += tokens
    }
  }
  if (current.length > 0) {
    chunks.push(current.join('\n\n'))
  }
  return chunks
}

const runChunkedSummaryFold = async (
  params: RunCompactionParams,
  spanMessages: readonly Message[]
): Promise<StreamSummaryOutcome> => {
  const { provider, model, system, policy, priorCheckpoint, trigger, tokensBefore, signal } = params
  const midTurn = params.inProgressReply !== undefined

  // Include prior checkpoint summary plus every message after the prior checkpoint (prevents prior summary loss).
  const entries: string[] = []
  let startIndex = 0
  if (priorCheckpoint) {
    entries.push(`[Prior checkpoint summary]\n${priorCheckpoint.summary}`)
    const anchorIdx = spanMessages.findIndex((m) => m.id === priorCheckpoint.anchorMessageId)
    if (anchorIdx >= 0) {
      if (priorCheckpoint.afterBlockIndex !== undefined) {
        const anchorMsg = spanMessages[anchorIdx]
        if (anchorMsg.role === 'assistant') {
          const tail = serializeBlocksForChunk(
            anchorMsg.blocks.slice(priorCheckpoint.afterBlockIndex + 1)
          )
          if (tail) {
            entries.push(`[Assistant]\n${tail}`)
          }
        }
      }
      startIndex = anchorIdx + 1
    }
  }

  for (let i = startIndex; i < spanMessages.length; i += 1) {
    const serialized = serializeMessageForChunk(spanMessages[i])
    if (serialized) {
      entries.push(serialized)
    }
  }

  if (entries.length === 0) {
    return { kind: 'failed', reason: 'No compactable transcript content found for chunked fold.' }
  }

  const targetChunkTokens = Math.max(1_024, Math.floor(policy.ceiling * 0.5))
  const queue = buildPlainTextChunks(entries, targetChunkTokens)
  if (queue.length > MAX_CHUNK_COUNT) {
    return {
      kind: 'failed',
      reason: `Transcript required ${queue.length} chunks, above the limit of ${MAX_CHUNK_COUNT}.`,
    }
  }

  let runningSummary: string | null = null
  let halvings = 0
  let processed = 0

  while (queue.length > 0) {
    const chunkText = queue.shift()
    if (chunkText === undefined) {
      break
    }
    const totalChunks = processed + queue.length + 1
    const prompt = buildChunkedCompactionPrompt({
      chunkText,
      previousSummary: runningSummary,
      chunkIndex: processed,
      totalChunks,
      trigger,
      tokensBefore,
      line: policy.line,
      contextWindow: policy.contextWindow,
      midTurn,
    })

    const outcome = await streamSummaryOnce(
      provider,
      {
        model,
        system,
        messages: [{ role: 'user', content: prompt }],
        tools: [],
      },
      signal
    )

    if (outcome.kind === 'ok') {
      runningSummary = outcome.summary
      processed += 1
      continue
    }
    if (outcome.kind === 'cancelled') {
      return outcome
    }
    if (
      outcome.kind === 'overflow' &&
      halvings < MAX_CHUNK_HALVINGS &&
      chunkText.length > 400 &&
      processed + queue.length + 2 <= MAX_CHUNK_COUNT
    ) {
      halvings += 1
      const mid = Math.floor(chunkText.length / 2)
      queue.unshift(chunkText.slice(mid), chunkText.slice(0, mid))
      continue
    }
    return outcome.kind === 'overflow'
      ? {
          kind: 'failed',
          reason: 'Compaction chunk still exceeded the model context limit.',
          error: outcome.error,
        }
      : outcome
  }

  return runningSummary
    ? { kind: 'ok', summary: runningSummary }
    : { kind: 'failed', reason: 'Chunked compaction produced no summary.' }
}

/**
 * Single compaction pipeline for all five triggers (`turnStart`, `betweenRounds`, `manual`, `fit`,
 * `overflow`). Tries the cache-riding path first when the prefix fits under `policy.ceiling`,
 * falls back to chunked plain-text folding when oversized, validates output, and returns a frozen
 * branch-anchored `CompactionCheckpoint` without mutating caller state on failure or abort.
 */
export const runCompaction = async (params: RunCompactionParams): Promise<CompactionResult> => {
  const {
    provider,
    toolRegistry,
    trigger,
    model,
    system,
    tools,
    history,
    pendingQuestion,
    inProgressReply,
    priorCheckpoint,
    declaredClientNames,
    providerId,
    inlineBlobs,
    inlineToolImages,
    environmentContext,
    includeInProgressThinking,
    tokensBefore,
    policy,
    signal,
    newId,
    now = () => Date.now(),
  } = params

  const midTurn = inProgressReply !== undefined
  const historyRounds = getContextRounds([...history])

  let anchorMessageId: string
  let afterBlockIndex: number | undefined
  let spanMessages: Message[]
  let verbatimSourceMessages: Message[]
  let cachePrefixMessages: MessageParam[]
  let midTurnRequest: string | undefined

  if (midTurn) {
    const lastBlockIndex = inProgressReply.blocks.length - 1
    if (lastBlockIndex < 0 && historyRounds.length === 0) {
      return { kind: 'notNeeded', reason: 'noHistory' }
    }
    anchorMessageId = inProgressReply.id
    afterBlockIndex = Math.max(0, lastBlockIndex)
    const activeQuestion = pendingQuestion
    spanMessages = [...history, ...(activeQuestion ? [activeQuestion] : []), inProgressReply]
    verbatimSourceMessages = [...history]
    if (activeQuestion) {
      const fileNames = activeQuestion.files.map((f) => f.name)
      const parts: string[] = []
      if (fileNames.length > 0) {
        parts.push(`[Attached: ${fileNames.join(', ')}]`)
      }
      if (activeQuestion.content.trim()) {
        parts.push(activeQuestion.content.trim())
      }
      midTurnRequest = parts.join('\n') || undefined
    }
    cachePrefixMessages = activeQuestion
      ? toRequestMessages([...history], activeQuestion, {
          checkpoint: priorCheckpoint,
          environmentContext,
          inProgress: inProgressReply,
          includeInProgressThinking,
          clientTools: declaredClientNames,
          providerId,
          inlineBlobs,
          inlineToolImages,
        })
      : []
  } else {
    const lastRound = historyRounds.at(-1)
    if (!lastRound) {
      return { kind: 'notNeeded', reason: 'noHistory' }
    }
    const [, lastReply] = lastRound
    anchorMessageId = lastReply.id
    afterBlockIndex = undefined
    const anchorPos = history.findIndex((m) => m.id === anchorMessageId)
    spanMessages = anchorPos >= 0 ? history.slice(0, anchorPos + 1) : [...history]
    verbatimSourceMessages = spanMessages
    cachePrefixMessages = toHistoryPrefixMessages(spanMessages, {
      checkpoint: priorCheckpoint,
      clientTools: declaredClientNames,
      providerId,
      inlineBlobs,
    })
  }

  const droppedReasoning =
    midTurn && inProgressReply.blocks.some((block) => block.type === 'thinking')

  const instruction = buildCompactionInstruction({
    trigger,
    tokensBefore,
    line: policy.line,
    contextWindow: policy.contextWindow,
    hasPendingQuestion: Boolean(pendingQuestion) && !midTurn,
    midTurn,
    droppingReasoning: droppedReasoning,
  })

  const cacheMessages = appendUserInstruction(cachePrefixMessages, instruction)
  const cachePrefixTokens = estimateMessagesTokens(cacheMessages, system, tools)

  let summaryOutcome: StreamSummaryOutcome
  if (cachePrefixMessages.length > 0 && cachePrefixTokens < policy.ceiling) {
    summaryOutcome = await streamSummaryOnce(
      provider,
      {
        model,
        system,
        messages: cacheMessages,
        tools,
      },
      signal
    )
    if (summaryOutcome.kind === 'overflow') {
      summaryOutcome = await runChunkedSummaryFold(params, spanMessages)
    }
  } else {
    summaryOutcome = await runChunkedSummaryFold(params, spanMessages)
  }

  if (summaryOutcome.kind === 'cancelled') {
    return { kind: 'cancelled' }
  }
  if (summaryOutcome.kind === 'overflow') {
    return {
      kind: 'failed',
      reason: 'Compaction summary exceeded the model context limit.',
      originalError: summaryOutcome.error,
    }
  }
  if (summaryOutcome.kind !== 'ok') {
    return {
      kind: 'failed',
      reason: summaryOutcome.reason,
      ...(summaryOutcome.error !== undefined ? { originalError: summaryOutcome.error } : {}),
    }
  }

  // Build deterministic factual ledger (bounded so huge file histories cannot blow up a checkpoint).
  const maxLedgerTokens = Math.min(
    10_000,
    Math.max(512, Math.floor(policy.keepRecentTokens * 0.25))
  )
  const ledger = buildCompactionLedgerText({
    messages: spanMessages,
    tools: toolRegistry,
    maxTokens: maxLedgerTokens,
  })

  // Assemble checkpoint, shrinking verbatim dialogue first if total rendered text exceeds half the line.
  const baseWithoutVerbatim = renderCheckpointWireText({
    trigger,
    droppedReasoning,
    summary: summaryOutcome.summary,
    ledger,
    verbatim: '',
    midTurnRequest,
  })
  const baseTokens = estimateTextTokens(baseWithoutVerbatim)
  const availableVerbatimBudget = Math.max(
    0,
    Math.min(policy.keepRecentTokens, policy.maxCheckpointTokens - baseTokens)
  )

  let verbatim = buildVerbatimSection(verbatimSourceMessages, availableVerbatimBudget)
  let renderedWireText = renderCheckpointWireText({
    trigger,
    droppedReasoning,
    summary: summaryOutcome.summary,
    ledger,
    verbatim: verbatim.text,
    midTurnRequest,
  })

  const pendingOverhead =
    !midTurn && pendingQuestion
      ? estimateTextTokens(pendingQuestion.content) + pendingQuestion.files.length * 1_000
      : 0
  const systemTokens = estimateMessagesTokens([], system, tools)

  // Final safety check: if rendered checkpoint + system + pending request would still exceed ceiling,
  // drop verbatim completely and re-check before refusing.
  if (estimateTextTokens(renderedWireText) + systemTokens + pendingOverhead >= policy.ceiling) {
    verbatim = buildVerbatimSection(verbatimSourceMessages, 0)
    renderedWireText = baseWithoutVerbatim
    if (estimateTextTokens(renderedWireText) + systemTokens + pendingOverhead >= policy.ceiling) {
      return {
        kind: 'failed',
        reason: 'Compacted checkpoint and pending request still exceed the model context ceiling.',
      }
    }
  }

  const tokensAfter = estimateTextTokens(renderedWireText) + systemTokens + pendingOverhead
  const checkpoint: CompactionCheckpoint = {
    id: newId(),
    anchorMessageId,
    ...(afterBlockIndex !== undefined ? { afterBlockIndex } : {}),
    trigger,
    createdAt: now(),
    renderedWireText,
    summary: summaryOutcome.summary,
    keptMessagesCount: verbatim.keptMessagesCount,
    droppedMessagesCount: verbatim.droppedMessagesCount,
    droppedReasoning,
    tokensBefore,
    tokensAfter,
  }

  return { kind: 'compacted', checkpoint }
}
