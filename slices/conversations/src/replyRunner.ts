import {
  isRetryableApiError,
  type ChatModel,
  type CreateMessageRequest,
  type ModelProvider,
  type ProviderId,
} from '@deepseek-chat/lib-agent'
import type { ToolRegistry, ToolRunResult } from '@deepseek-chat/lib-tools'
import type {
  ReplyLifecycleChanged,
  SessionFileDescriptor,
  ToolFileDelivered,
} from '@deepseek-chat/spine/facts/session'
import type { Locale } from '@deepseek-chat/spine/i18n'
import type { EventLog } from '@deepseek-chat/spine/runtime'
import { ApiError } from './apiClient.js'
import { describeUploadError, type UploadsController } from './attachments.js'
import type { AutoTitleParams } from './autoTitleRunner.js'
import { collectCitedUrls } from './citations.js'
import { computeCompactionPolicy, selectCompactionTrigger } from './compaction/budget.js'
import { runCompaction } from './compaction/compact.js'
import { estimateMessagesTokens, estimateSessionContext } from './compaction/estimate.js'
import { createEnvironmentContext, resolveEnvironmentContext } from './environmentContext.js'
import type { TranslationKey } from './messages.js'
import {
  applyEvent,
  findActiveCheckpoint,
  getContextRounds,
  pickImageResults,
  settleReply,
  toRequestMessages,
  type InlineAttachmentData,
} from './reply.js'
import { createStreamTracer, type StreamTrace } from './streamTrace.js'
import type {
  AssistantMessage,
  CompactionCheckpoint,
  CompactionTrigger,
  FileAttachment,
  Message,
  Session,
  ToolCallPart,
  ToolResultPart,
  UserMessage,
} from './types.js'

/** Static core harness orientation shared by every turn (kept static so KV-cache prefix stays hot). */
export const SYSTEM_PROMPT = [
  'You are an AI assistant running inside a local split-pane chat app (desktop on macOS, or web in a browser).',
  'Here is how the app around you works so you can operate it naturally:\n' +
    '- Left pane (the chat): Your conversation with the user. While you work, the transcript shows a compact live status line above your reply (never a long vertical wall of tool logs); once your answer arrives, thinking and tool work fold into a single quiet summary row above your reply that users can expand inline for a compact step trace, while produced files, generated charts, and a unified Sources button stay visible with your answer. A minimap on the right edge of the chat shows the whole conversation in miniature, so users can see its shape and jump back to earlier turns.\n' +
    '- Right pane (the workspace panel): A single shared side panel with peer toggles in the chat header (File Preview, Built-in Browser, and the Activity & Sources inspector, which scrolls through the steps of every turn in step with the chat, so users can inspect code, screenshots, reasoning, and cited sources side by side without disrupting the chat).\n' +
    "- Tool `summary` field: Every client tool accepts a `summary` parameter first. Always emit a plain, active 1-sentence summary (6–18 words, in the user's language) explaining what the call is doing and why, using ordinary words rather than compressed shorthand. The app displays it directly as the live status line while you work and inside the Activity inspector afterwards, so the user can follow your progress at a glance.\n" +
    '- Time and environment: The current local date, weekday, platform (`Desktop app` or `Web browser`), user location (if set), and UI language are provided in an `<environment_context>` block on user messages whenever they first appear or change, rather than here, so your prompt prefix stays cacheable across turns.',
  'How to communicate:\n' +
    "Write like a clear, thoughtful person talking to someone who only has your reply on screen. They didn't see your collapsed thinking, your tool logs, or the raw pages you read. Match the user's language, depth, and tone: conversational when chatting, direct when answering a concrete question, and structured only when headings, lists, or tables genuinely make a multi-part answer easier to scan. Don't turn a short reply into a mini-report with a closing summary.\n\n" +
    'A few habits tend to creep into long or tool-heavy turns; watch for them:\n' +
    '- Compressing syntax: stacking nouns together or dropping small connecting words saves tokens for you, while forcing the reader to unpack your sentence. Say who or what does what with plain, literal verbs.\n' +
    "- Leaking working context: don't assume the reader shares shorthand labels, internal jargon, or raw tool terms you just read. Use ordinary words first and put technical identifiers in backticks.\n" +
    '- Performing thoroughness: skip cheerleading openers, fake-profound signposts ("Crucially,", "What this means:"), unprompted "not X, but Y" setups, and wrap-up paragraphs that restate what you already said.\n' +
    "- Punctuation and decoration crutches: default to periods, commas, colons, and parentheses instead of em dashes, saving a dash for the rare sentence that truly needs an abrupt turn. Don't decorate headings, bullets, or explanations with emojis; keep them for moments where the user sets that tone or asks for them.\n\n" +
    'Never trade away accuracy for smoothness: keep important numbers, units, and conditions intact. What the user asks for always wins.',
  'Your context:\n' +
    'Long conversations are compacted into a checkpoint automatically when context approaches the model limit (between turns or between tool rounds), or when the user asks to compact. A checkpoint keeps a structured summary, recent messages verbatim, and a factual ledger of uploaded files, saved workspace artifacts, gathered sources, and answered decisions, while dropping raw older tool outputs, earlier attachments, and pre-checkpoint hidden reasoning. State settled conclusions, key numbers, and important decisions plainly in your reply prose as you work so they survive compaction cleanly; if you ever need exact raw content from an earlier saved file or webpage after a checkpoint, re-read it with the appropriate tool rather than guessing.',
].join('\n\n')

const DEFAULT_TOOL_ROUND_LIMIT = 50

export type ReplyRequest = {
  readonly history: Message[]
  readonly question: UserMessage
  readonly continueReply?: AssistantMessage
}

export type ReplyRunnerParams = {
  readonly maxParallelReadCalls: number
  readonly toolRoundLimit: number
  readonly networkRetryLimit: number
  readonly fileReuploadLimit: number
  readonly retryBaseDelayMs: number
}

export type ReplyRunnerHost = {
  readonly log: EventLog
  readonly getLocale: () => Locale
  readonly readBlob: (id: string) => Promise<Blob | undefined>
  readonly tools: ToolRegistry
  readonly provider: ModelProvider
  readonly uploads: Pick<UploadsController, 'useUploads' | 'uploadAttachment' | 'cancelUpload'>
  readonly platform: 'desktop' | 'web'
  readonly params: ReplyRunnerParams
  readonly getLocationLabel: (locale: Locale) => string
  readonly onStreamTrace?: (trace: StreamTrace) => void
  readonly getHistoryEpoch: () => number
  readonly isImportingHistory: () => boolean
  readonly getActiveSessionId: () => string | null
  readonly getSession: (sessionId: string) => Session | undefined
  readonly updateSession: (sessionId: string, updater: (session: Session) => Session) => void
  readonly updateReply: (sessionId: string, reply: AssistantMessage) => void
  readonly persist: (sessionId: string) => void
  readonly publishSessionFiles: (sessionId: string) => void
  readonly setStreaming: (sessionId: string, controller: AbortController | null) => void
  readonly setCompacting: (sessionId: string, active: boolean) => void
  readonly appendCheckpoint: (sessionId: string, checkpoint: CompactionCheckpoint) => void
  readonly notifyCompactionNotice: (key: TranslationKey) => void
  readonly newId: () => string
  readonly registerFlush: (sessionId: string, flush: (() => void) | null) => void
  readonly onAutoTitle: (params: AutoTitleParams) => void
}

const dataUrlToFile = (dataUrl: string, name: string): File => {
  const [header, data] = dataUrl.split(',', 2)
  const type = /data:([^;]+)/.exec(header)?.[1] ?? 'image/jpeg'
  const binary = atob(data ?? '')
  const bytes = new Uint8Array(binary.length)
  for (let i = 0; i < binary.length; i += 1) {
    bytes[i] = binary.charCodeAt(i)
  }
  return new File([bytes], name, { type })
}

const blobToBase64 = async (blob: Blob): Promise<string> => {
  const bytes = new Uint8Array(await blob.arrayBuffer())
  let binary = ''
  const chunkSize = 0x8000
  for (let offset = 0; offset < bytes.length; offset += chunkSize) {
    binary += String.fromCharCode(...bytes.subarray(offset, offset + chunkSize))
  }
  return btoa(binary)
}

const hasMatchingServerId = (file: FileAttachment, providerId: ProviderId): boolean =>
  Boolean(file.serverId && (file.serverProvider ?? 'deepseek') === providerId)

const pendingToolCalls = (reply: AssistantMessage): ToolCallPart[] => {
  const done = new Set(
    reply.blocks.flatMap((block) => (block.type === 'tool_result' ? [block.tool_use_id] : []))
  )
  return reply.blocks.flatMap((block) =>
    block.type === 'tool_use' && !done.has(block.id) ? [block] : []
  )
}

const collectServerFileIds = (request: ReplyRequest, providerId: ProviderId): Set<string> => {
  const ids = new Set<string>()
  const add = (files: FileAttachment[]) => {
    for (const file of files) {
      if (file.serverId && (file.serverProvider ?? 'deepseek') === providerId) {
        ids.add(file.serverId)
      }
    }
  }
  add(request.question.files)
  for (const [user] of getContextRounds(request.history)) {
    add(user.files)
  }
  return ids
}

export const createReplyRunner = (host: ReplyRunnerHost) => {
  const waitForRetry = (attempt: number, signal: AbortSignal) =>
    new Promise<void>((resolve) => {
      function onAbort() {
        clearTimeout(timer)
        resolve()
      }
      const timer = setTimeout(
        () => {
          signal.removeEventListener('abort', onAbort)
          resolve()
        },
        host.params.retryBaseDelayMs * 2 ** attempt
      )
      signal.addEventListener('abort', onAbort, { once: true })
    })

  const saveServerIds = (sessionId: string, serverIds: Map<string, string>) => {
    if (serverIds.size === 0) {
      return
    }
    const providerId = host.provider.id
    host.updateSession(sessionId, (session) => ({
      ...session,
      messages: session.messages.map((message) =>
        message.role === 'user' && message.files.some((file) => serverIds.has(file.id))
          ? {
              ...message,
              files: message.files.map((file) =>
                serverIds.has(file.id)
                  ? {
                      ...file,
                      serverId: serverIds.get(file.id) ?? null,
                      serverProvider: providerId,
                    }
                  : file
              ),
            }
          : message
      ),
    }))
    host.persist(sessionId)
  }

  const ensureServerId = async (file: FileAttachment): Promise<string | null> => {
    const providerId = host.provider.id
    if (hasMatchingServerId(file, providerId)) {
      return file.serverId
    }
    const task = host.uploads.useUploads.getState().tasks[file.id]
    if (task?.status === 'done' && task.serverId && task.providerId === providerId) {
      return task.serverId
    }
    const blob = await host.readBlob(file.id)
    if (!blob) {
      return null
    }
    return host.uploads.uploadAttachment(
      file.id,
      blob,
      file.name,
      file.mimeType || blob.type || 'application/octet-stream',
      file.isImage
    )
  }

  const refreshRequest = (sessionId: string, request: ReplyRequest): ReplyRequest => {
    const session = host.getSession(sessionId)
    if (!session) {
      return request
    }
    const byId = new Map(session.messages.map((message) => [message.id, message]))
    const pick = <T extends Message>(message: T): T =>
      (byId.get(message.id) as T | undefined) ?? message
    return {
      history: request.history.map(pick),
      question: pick(request.question),
      continueReply: request.continueReply,
    }
  }

  const prepareFiles = async (sessionId: string, request: ReplyRequest, signal: AbortSignal) => {
    const epoch = host.getHistoryEpoch()
    request = refreshRequest(sessionId, request)
    const providerId = host.provider.id

    if (!host.provider.attachments) {
      const inlineBlobs = new Map<string, InlineAttachmentData>()
      const loadInline = async (file: FileAttachment) => {
        if (inlineBlobs.has(file.id)) {
          return
        }
        signal.throwIfAborted()
        const blob = await host.readBlob(file.id)
        if (!blob) {
          return
        }
        const base64 = await blobToBase64(blob)
        inlineBlobs.set(file.id, {
          mediaType: file.mimeType || blob.type || 'application/octet-stream',
          base64,
        })
      }
      for (const file of request.question.files) {
        await loadInline(file)
      }
      for (const [user] of getContextRounds(request.history)) {
        for (const file of user.files) {
          await loadInline(file)
        }
      }
      return {
        history: request.history,
        question: request.question,
        continueReply: request.continueReply,
        inlineBlobs,
      }
    }

    const serverIds = new Map<string, string>()
    const aborted = new Promise<never>((_, reject) => {
      signal.addEventListener('abort', () => reject(signal.reason), { once: true })
    })
    const uploads = Promise.allSettled(
      request.question.files.map(async (file) => {
        const serverId = await ensureServerId(file)
        if (serverId) {
          serverIds.set(file.id, serverId)
        }
      })
    )
    void uploads.then(() => {
      if (epoch === host.getHistoryEpoch()) {
        saveServerIds(sessionId, serverIds)
      }
    })
    const results = await Promise.race([uploads, aborted])
    const failed = results.find((result) => result.status === 'rejected')
    if (failed) {
      throw failed.reason
    }

    const pending = new Map<string, FileAttachment>()
    for (const [user] of getContextRounds(request.history).toReversed()) {
      for (const file of user.files) {
        if (
          !hasMatchingServerId(file, providerId) &&
          !serverIds.has(file.id) &&
          !pending.has(file.id)
        ) {
          pending.set(file.id, file)
        }
      }
    }
    for (const file of pending.values()) {
      signal.throwIfAborted()
      try {
        const serverId = await Promise.race([ensureServerId(file), aborted])
        if (serverId) {
          serverIds.set(file.id, serverId)
          saveServerIds(sessionId, new Map([[file.id, serverId]]))
        }
      } catch {
        signal.throwIfAborted()
      }
    }

    const session = host.getSession(sessionId)
    const resolve = <T extends Message>(message: T): T =>
      (session?.messages.find((m) => m.id === message.id) as T | undefined) ?? message
    return {
      history: request.history.map(resolve),
      question: resolve(request.question),
      continueReply: request.continueReply,
      inlineBlobs: undefined as ReadonlyMap<string, InlineAttachmentData> | undefined,
    }
  }

  const reuploadInvalidatedFiles = (
    sessionId: string,
    request: ReplyRequest,
    error: unknown
  ): boolean => {
    const attachmentPort = host.provider.attachments
    if (!attachmentPort) {
      return false
    }
    const invalidated = attachmentPort.invalidatedFileIds(error)
    if (invalidated === null) {
      return false
    }
    const targets =
      invalidated.length > 0
        ? new Set(invalidated)
        : collectServerFileIds(refreshRequest(sessionId, request), host.provider.id)
    const session = host.getSession(sessionId)
    if (targets.size === 0 || !session) {
      return false
    }
    const localIds: string[] = []
    const messages = session.messages.map((message) => {
      if (message.role !== 'user') {
        return message
      }
      let changed = false
      const files = message.files.map((file) => {
        if (!file.serverId || !targets.has(file.serverId)) {
          return file
        }
        localIds.push(file.id)
        changed = true
        return { ...file, serverId: null, serverProvider: undefined }
      })
      return changed ? { ...message, files } : message
    })
    if (localIds.length === 0) {
      return false
    }
    host.updateSession(sessionId, (current) => ({ ...current, messages }))
    localIds.forEach(host.uploads.cancelUpload)
    host.persist(sessionId)
    return true
  }

  const streamReply = async (
    sessionId: string,
    initial: AssistantMessage,
    request: ReplyRequest
  ) => {
    const epoch = host.getHistoryEpoch()
    const controller = new AbortController()
    host.setStreaming(sessionId, controller)
    host.log.publish<ReplyLifecycleChanged>({
      type: 'ReplyLifecycleChanged',
      sessionId,
      messageId: initial.id,
      phase: 'started',
    })

    let reply = initial
    let settledByRoundLimit = false
    let lastTurnContext: {
      model: ChatModel
      system: string
      tools: CreateMessageRequest['tools']
      history: Message[]
      question: UserMessage
      declaredClientNames: ReadonlySet<string>
      inlineBlobs?: ReadonlyMap<string, InlineAttachmentData>
    } | null = null
    let frame = 0
    const flush = () => {
      cancelAnimationFrame(frame)
      frame = 0
      host.updateReply(sessionId, reply)
    }
    host.registerFlush(sessionId, flush)

    const toolRoundLimit = Math.max(1, host.params.toolRoundLimit || DEFAULT_TOOL_ROUND_LIMIT)
    let toolRound =
      !request.continueReply && initial.blocks.some((block) => block.type === 'tool_use') ? 1 : 0

    const readCapState = (capabilityId: string) => {
      const map = reply.capabilityState
      return map && Object.hasOwn(map, capabilityId) ? map[capabilityId] : undefined
    }

    const writeCapState = (
      capabilityId: string,
      next: unknown,
      options?: { readonly persist?: boolean }
    ) => {
      reply = {
        ...reply,
        capabilityState: {
          ...reply.capabilityState,
          [capabilityId]: next,
        },
      }
      if (options?.persist !== false) {
        flush()
        host.persist(sessionId)
      } else if (typeof document !== 'undefined' && document.visibilityState === 'hidden') {
        flush()
      } else {
        frame ||= requestAnimationFrame(flush)
      }
    }

    const settleTurnHooks = (reason: 'done' | 'user' | 'interrupted' | 'roundLimit') => {
      for (const { capabilityId, hooks } of host.tools.turnHooks) {
        hooks.onTurnSettled?.({
          sessionId,
          replyId: reply.id,
          reason,
          readReplyState: () => readCapState(capabilityId),
          writeReplyState: (next, opts) => writeCapState(capabilityId, next, opts),
        })
      }
    }

    const uploadToolImages = async () => {
      const attachmentPort = host.provider.attachments
      if (!attachmentPort) {
        return
      }
      for (const block of pickImageResults(reply.blocks)) {
        const images = block.images ?? []
        const ids = [...(block.imageFileIds ?? [])]
        if (images.every((_, index) => ids[index] !== undefined)) {
          continue
        }
        for (const [index, image] of images.entries()) {
          if (ids[index] !== undefined) {
            continue
          }
          try {
            const name = `tool-output-${block.tool_use_id}-${index + 1}.jpg`
            const file = dataUrlToFile(image, name)
            ids[index] = await attachmentPort.upload(
              {
                id: `${block.tool_use_id}-${index + 1}`,
                blob: file,
                name,
                mimeType: file.type || 'image/jpeg',
                isImage: true,
              },
              controller.signal
            )
          } catch (error) {
            if (controller.signal.aborted) {
              throw error
            }
            ids[index] = null
          }
        }
        reply = {
          ...reply,
          blocks: reply.blocks.map((item) =>
            item === block ? { ...block, imageFileIds: ids } : item
          ),
        }
        flush()
      }
    }

    const runToolCalls = async (calls: ToolCallPart[]) => {
      const maxParallel = Math.max(1, host.params.maxParallelReadCalls)
      const updateResult = (callId: string, patch: Partial<ToolResultPart>) => {
        reply = {
          ...reply,
          blocks: reply.blocks.map((block) =>
            block.type === 'tool_result' && block.tool_use_id === callId
              ? { ...block, ...patch }
              : block
          ),
        }
        flush()
      }

      const executeCall = async (
        call: ToolCallPart,
        formatters?: Map<string, (urlToIndex: ReadonlyMap<string, number>) => string>
      ) => {
        const startedAt = Date.now()
        const capabilityId = host.tools.capabilityIdOf(call.name) ?? undefined
        const initialProgress = host.tools.initialProgressOf(call.name)
        reply = {
          ...reply,
          blocks: [
            ...reply.blocks,
            {
              type: 'tool_result',
              tool_use_id: call.id,
              ...(capabilityId ? { capability: capabilityId } : {}),
              content: '',
              status: 'running',
              ...(initialProgress ? { progress: initialProgress } : {}),
              startedAt,
            },
          ],
        }
        flush()

        const spawnIndex = reply.blocks.findIndex(
          (block) => block.type === 'tool_use' && block.id === call.id
        )
        const replyBeforeCall: AssistantMessage = {
          ...reply,
          blocks: spawnIndex >= 0 ? reply.blocks.slice(0, spawnIndex) : reply.blocks,
        }
        const effectiveCapId = capabilityId ?? call.name
        const currentEnv = resolveEnvironmentContext(reply)
        const outcome: ToolRunResult & { readonly capabilityId?: string } = await host.tools.run(
          call,
          {
            sessionId,
            replyId: reply.id,
            signal: controller.signal,
            caller: { kind: 'reply' },
            ...(call.inputJson !== undefined ? { inputJson: call.inputJson } : {}),
            citedUrls: collectCitedUrls(reply.blocks),
            isActive: () => host.getActiveSessionId() === sessionId,
            onProgress: (progress) => updateResult(call.id, { progress }),
            readReplyState: <T = unknown>() => readCapState(effectiveCapId) as T | undefined,
            writeReplyState: (next, opts) => writeCapState(effectiveCapId, next, opts),
            ...(currentEnv ? { environmentContext: currentEnv } : {}),
            forkMessages: () => {
              const history = lastTurnContext?.history ?? request.history
              const activeCheckpoint = findActiveCheckpoint(
                history,
                host.getSession(sessionId)?.checkpoints,
                replyBeforeCall.blocks.length > 0 ? replyBeforeCall.id : undefined
              )
              return toRequestMessages(history, lastTurnContext?.question ?? request.question, {
                checkpoint: activeCheckpoint ?? undefined,
                environmentContext: currentEnv,
                inProgress: replyBeforeCall.blocks.length > 0 ? replyBeforeCall : undefined,
                includeInProgressThinking:
                  Boolean(initial.thinking) &&
                  (reply.provider ?? host.provider.id) === host.provider.id &&
                  (reply.model ?? host.provider.defaultModel) ===
                    (lastTurnContext?.model ?? initial.model ?? host.provider.defaultModel),
                clientTools: lastTurnContext?.declaredClientNames ?? true,
                providerId: host.provider.id,
                inlineBlobs: lastTurnContext?.inlineBlobs,
                inlineToolImages: !host.provider.attachments,
              })
            },
          }
        )

        if (formatters && outcome.formatContentWithCitations) {
          formatters.set(call.id, outcome.formatContentWithCitations)
        }

        const resolvedCapability = outcome.capabilityId ?? capabilityId
        updateResult(call.id, {
          ...(resolvedCapability ? { capability: resolvedCapability } : {}),
          content: outcome.content,
          status: outcome.status,
          durationMs: outcome.durationMs ?? Date.now() - startedAt,
          ...(outcome.images ? { images: outcome.images } : {}),
          ...(outcome.previewImages ? { previewImages: outcome.previewImages } : {}),
          ...(outcome.files ? { files: outcome.files } : {}),
          ...(outcome.sources ? { sources: outcome.sources } : {}),
          ...(outcome.frontStageNote ? { frontStageNote: outcome.frontStageNote } : {}),
          ...(outcome.payload !== undefined ? { payload: outcome.payload } : {}),
        })
        host.persist(sessionId)

        if (outcome.files && outcome.files.length > 0) {
          host.publishSessionFiles(sessionId)
          const isActiveSession = host.getActiveSessionId() === sessionId
          for (const file of outcome.files) {
            const descriptor: SessionFileDescriptor = {
              kind: 'delivered',
              fileId: file.id,
              name: file.name,
              size: file.size,
              mimeType: file.mimeType,
              ...(file.path ? { path: file.path } : {}),
              ...(file.title ? { title: file.title } : {}),
              ...(file.version !== undefined ? { version: file.version } : {}),
              ...((file.producer ?? resolvedCapability)
                ? { producer: file.producer ?? resolvedCapability }
                : {}),
              producedByTool: call.name,
              messageId: reply.id,
              createdAt: reply.createdAt,
            }
            host.log.publish<ToolFileDelivered>({
              type: 'ToolFileDelivered',
              sessionId,
              messageId: reply.id,
              file: descriptor,
              isActiveSession,
            })
          }
        }
      }

      const isConcurrentRead = (call: ToolCallPart) => host.tools.effectOf(call.name) === 'read'

      for (let i = 0; i < calls.length; ) {
        if (controller.signal.aborted) {
          return
        }
        const first = calls[i]
        if (!first) {
          break
        }
        if (!isConcurrentRead(first)) {
          await executeCall(first)
          i += 1
          continue
        }
        let end = i + 1
        while (end < calls.length && isConcurrentRead(calls[end])) {
          end += 1
        }
        const segment = calls.slice(i, end)
        i = end
        const baseCitedUrls = segment.length > 1 ? collectCitedUrls(reply.blocks) : null
        const formatters = new Map<string, (urlToIndex: ReadonlyMap<string, number>) => string>()
        let cursor = 0
        const workerCount = Math.min(maxParallel, segment.length)
        const worker = async () => {
          while (!controller.signal.aborted) {
            const nextIndex = cursor
            if (nextIndex >= segment.length) {
              return
            }
            cursor += 1
            await executeCall(segment[nextIndex], baseCitedUrls ? formatters : undefined)
          }
        }
        await Promise.all(Array.from({ length: workerCount }, () => worker()))

        // Reconcile citation indices across concurrent read batches in deterministic call order.
        if (baseCitedUrls && !controller.signal.aborted) {
          const runningCited = new Map(baseCitedUrls)
          let changed = false
          for (const call of segment) {
            const block = reply.blocks.find(
              (b): b is ToolResultPart => b.type === 'tool_result' && b.tool_use_id === call.id
            )
            if (!block) {
              continue
            }
            for (const source of block.sources ?? []) {
              const url = source.url.trim()
              if (url && !runningCited.has(url)) {
                runningCited.set(url, runningCited.size + 1)
              }
            }
            const formatter = formatters.get(call.id)
            if (formatter) {
              const rewritten = formatter(runningCited)
              if (rewritten !== block.content) {
                updateResult(call.id, { content: rewritten })
                changed = true
              }
            }
          }
          if (changed) {
            host.persist(sessionId)
          }
        }
      }
    }

    const performCompaction = async (args: {
      readonly trigger: CompactionTrigger
      readonly model: ChatModel
      readonly system: string
      readonly tools: CreateMessageRequest['tools']
      readonly history: Message[]
      readonly question: UserMessage
      readonly inProgressReply?: AssistantMessage
      readonly priorCheckpoint?: CompactionCheckpoint
      readonly declaredClientNames: ReadonlySet<string>
      readonly inlineBlobs?: ReadonlyMap<string, InlineAttachmentData>
      readonly environmentContext?: string
      readonly includeInProgressThinking: boolean
      readonly tokensBefore: number
    }) => {
      const policy = computeCompactionPolicy(host.provider.modelSpec(args.model))
      host.setCompacting(sessionId, true)
      try {
        const result = await runCompaction({
          provider: host.provider,
          toolRegistry: host.tools,
          trigger: args.trigger,
          model: args.model,
          system: args.system,
          tools: args.tools,
          history: args.history,
          pendingQuestion: args.question,
          inProgressReply: args.inProgressReply,
          priorCheckpoint: args.priorCheckpoint,
          declaredClientNames: args.declaredClientNames,
          providerId: host.provider.id,
          inlineBlobs: args.inlineBlobs,
          inlineToolImages: !host.provider.attachments,
          environmentContext: args.environmentContext,
          includeInProgressThinking: args.includeInProgressThinking,
          tokensBefore: args.tokensBefore,
          policy,
          signal: controller.signal,
          newId: host.newId,
        })
        if (result.kind === 'compacted') {
          host.appendCheckpoint(sessionId, result.checkpoint)
        }
        return result
      } finally {
        host.setCompacting(sessionId, false)
      }
    }

    let networkRetries = 0
    let lineCompactionFailed = false
    let overflowRetried = false
    try {
      for (let attempt = 0; ; attempt += 1) {
        let preparing = true
        let receivedContent = false
        let tracer: ReturnType<typeof createStreamTracer> | null = null
        const finishTrace = (error?: unknown) => {
          if (tracer) {
            host.onStreamTrace?.(tracer.finish(Date.now(), error))
            tracer = null
          }
        }
        try {
          const calls = pendingToolCalls(reply)
          if (calls.length > 0) {
            if (toolRound >= toolRoundLimit) {
              settledByRoundLimit = true
              settleTurnHooks('roundLimit')
              reply = settleReply(reply, 'error', Date.now(), {
                kind: 'protocol',
                message: `Stopped after ${toolRoundLimit} rounds of tool calls in one reply.`,
              })
              break
            }
            toolRound += 1
            await runToolCalls(calls)
            if (controller.signal.aborted) {
              settleTurnHooks('user')
              reply = settleReply(reply, 'stopped', Date.now())
              break
            }
            host.persist(sessionId)
          }
          reply = { ...reply, stopReason: undefined, stopDetails: undefined }
          const prepared = await prepareFiles(sessionId, request, controller.signal)
          preparing = false
          const currentLocale = host.getLocale()
          const environmentContext = prepared.continueReply
            ? resolveEnvironmentContext(prepared.continueReply)
            : (resolveEnvironmentContext(reply) ??
              createEnvironmentContext({
                locale: currentLocale,
                locationLabel: host.getLocationLabel(currentLocale),
                platform: host.platform,
              }))
          const model = initial.model ?? host.provider.defaultModel
          reply = {
            ...reply,
            model,
            provider: reply.provider ?? host.provider.id,
            ...(environmentContext ? { environmentContext } : {}),
          }
          host.updateReply(sessionId, reply)
          host.persist(sessionId)
          if (toolRound > 0) {
            await uploadToolImages()
          }
          const enabledCapabilities = initial.enabledCapabilities ?? {}
          const declaredTools = host.tools.declare({
            questionText: prepared.question.content,
            enabledCapabilities,
          })
          const declaredClientNames = new Set(declaredTools.map((tool) => tool.name))
          const systemParts = [
            SYSTEM_PROMPT,
            ...host.tools.instructions(declaredClientNames, 'reply'),
          ]
          const system = systemParts.join('\n\n')
          const includeInProgressThinking =
            Boolean(initial.thinking) &&
            (reply.provider ?? host.provider.id) === host.provider.id &&
            (reply.model ?? model) === model
          const buildMessages = (checkpoint: CompactionCheckpoint | null) =>
            toRequestMessages(prepared.history, prepared.question, {
              checkpoint: checkpoint ?? undefined,
              continueReply: toolRound > 0 ? undefined : prepared.continueReply,
              environmentContext,
              inProgress: toolRound > 0 ? reply : undefined,
              includeInProgressThinking,
              clientTools: declaredClientNames,
              providerId: host.provider.id,
              inlineBlobs: prepared.inlineBlobs,
              inlineToolImages: !host.provider.attachments,
            })

          const checkpoints = host.getSession(sessionId)?.checkpoints
          let activeCheckpoint = findActiveCheckpoint(
            prepared.history,
            checkpoints,
            toolRound > 0 ? reply.id : undefined
          )
          let messages = buildMessages(activeCheckpoint)

          const modelSpec = host.provider.modelSpec(model)
          const policy = computeCompactionPolicy(modelSpec)
          const systemOverheadTokens = estimateMessagesTokens([], system, declaredTools)
          const wireEstimate = estimateMessagesTokens(messages, system, declaredTools)
          const sessionEstimate = estimateSessionContext({
            visibleMessages: [...prepared.history, prepared.question],
            checkpoints,
            modelSpec,
            inProgressReply: toolRound > 0 ? reply : undefined,
            systemOverheadTokens,
          })
          const estimatedTokens = Math.max(wireEstimate, sessionEstimate.tokens)
          const preTrigger = selectCompactionTrigger(
            estimatedTokens,
            policy,
            toolRound > 0 ? 'betweenRounds' : 'turnStart',
            lineCompactionFailed
          )
          const hasCompactableHistory =
            toolRound > 0
              ? reply.blocks.length > 0 || getContextRounds(prepared.history).length > 0
              : getContextRounds(prepared.history).length > 0

          if (preTrigger && hasCompactableHistory) {
            const compResult = await performCompaction({
              trigger: preTrigger,
              model,
              system,
              tools: declaredTools,
              history: prepared.history,
              question: prepared.question,
              inProgressReply: toolRound > 0 ? reply : undefined,
              priorCheckpoint: activeCheckpoint ?? undefined,
              declaredClientNames,
              inlineBlobs: prepared.inlineBlobs,
              environmentContext,
              includeInProgressThinking,
              tokensBefore: estimatedTokens,
            })
            if (compResult.kind === 'cancelled' || controller.signal.aborted) {
              settleTurnHooks('user')
              reply = settleReply(reply, 'stopped', Date.now())
              break
            }
            if (compResult.kind === 'compacted') {
              activeCheckpoint = compResult.checkpoint
              messages = buildMessages(activeCheckpoint)
            } else if (compResult.kind === 'failed') {
              if (preTrigger === 'fit') {
                reply = settleReply(reply, 'error', Date.now(), {
                  kind: 'protocol',
                  message: compResult.reason,
                  localMessage: { key: 'compactionFitFailed' },
                })
                break
              }
              lineCompactionFailed = true
              host.notifyCompactionNotice('compactionNoticeFailedContinuing')
            }
          }

          if (host.onStreamTrace) {
            tracer = createStreamTracer(toolRound, Date.now())
          }
          lastTurnContext = {
            model,
            system,
            tools: declaredTools,
            history: prepared.history,
            question: prepared.question,
            declaredClientNames,
            inlineBlobs: prepared.inlineBlobs,
          }
          const events = host.provider.streamMessage(
            {
              model,
              system,
              messages,
              thinking: { type: initial.thinking ? 'enabled' : 'disabled' },
              tools: declaredTools,
            },
            controller.signal
          )
          const blockIndexes = new Map<number, number>()
          try {
            for await (const event of events) {
              tracer?.record(event, Date.now())
              receivedContent ||= event.type === 'content_block_start'
              reply = applyEvent(reply, event, Date.now(), blockIndexes)
              if (typeof document !== 'undefined' && document.visibilityState === 'hidden') {
                flush()
              } else {
                frame ||= requestAnimationFrame(flush)
              }
            }
          } catch (error) {
            if (!(error instanceof ApiError && error.kind === 'interrupted' && reply.stopReason)) {
              throw error
            }
            finishTrace(error)
          }
          finishTrace()
          if (reply.stopReason !== 'refusal' && pendingToolCalls(reply).length > 0) {
            attempt = -1
            continue
          }
          // Let capability turn hooks request a synthetic continuation call (e.g. auto-wait for running subagents).
          if (reply.stopReason !== 'refusal') {
            let syntheticCall: ToolCallPart | null = null
            for (const { capabilityId, hooks } of host.tools.turnHooks) {
              const hookRes = hooks.onTurnEndWithoutToolCalls?.({
                sessionId,
                replyId: reply.id,
                readReplyState: () => readCapState(capabilityId),
                writeReplyState: (next, opts) => writeCapState(capabilityId, next, opts),
              })
              if (hookRes?.syntheticCall) {
                syntheticCall = {
                  type: 'tool_use',
                  id: hookRes.syntheticCall.id,
                  name: hookRes.syntheticCall.name,
                  input: hookRes.syntheticCall.input,
                  ...(hookRes.syntheticCall.inputJson !== undefined
                    ? { inputJson: hookRes.syntheticCall.inputJson }
                    : {}),
                }
                break
              }
            }
            if (syntheticCall) {
              if (toolRound >= toolRoundLimit) {
                settledByRoundLimit = true
                settleTurnHooks('roundLimit')
                reply = settleReply(reply, 'error', Date.now(), {
                  kind: 'protocol',
                  message: `Stopped after ${toolRoundLimit} rounds of tool calls in one reply.`,
                })
                break
              }
              reply = {
                ...reply,
                blocks: [...reply.blocks, syntheticCall],
              }
              flush()
              attempt = -1
              continue
            }
          }
          reply = settleReply(reply, 'done', Date.now())
          break
        } catch (error) {
          finishTrace(error)
          if (controller.signal.aborted) {
            settleTurnHooks('user')
            reply = settleReply(reply, 'stopped', Date.now())
            break
          }
          if (preparing) {
            reply = settleReply(reply, 'error', Date.now(), {
              kind: 'upload',
              message: '',
              localMessage: describeUploadError(error, host.provider),
              retryable: isRetryableApiError(error),
            })
            break
          }
          if (
            attempt < host.params.fileReuploadLimit &&
            !receivedContent &&
            reuploadInvalidatedFiles(sessionId, request, error)
          ) {
            await waitForRetry(attempt, controller.signal)
            if (controller.signal.aborted) {
              reply = settleReply(reply, 'stopped', Date.now())
              break
            }
            continue
          }
          if (
            error instanceof ApiError &&
            error.kind === 'network' &&
            !receivedContent &&
            networkRetries < host.params.networkRetryLimit
          ) {
            await waitForRetry(networkRetries, controller.signal)
            networkRetries += 1
            if (controller.signal.aborted) {
              reply = settleReply(reply, 'stopped', Date.now())
              break
            }
            attempt -= 1
            continue
          }
          const errorCondition = host.provider.classifyError(error)
          if (
            !receivedContent &&
            !overflowRetried &&
            lastTurnContext &&
            (errorCondition === 'contextOverflow' || errorCondition === 'payloadTooLarge')
          ) {
            overflowRetried = true
            const hasCompactable =
              toolRound > 0
                ? reply.blocks.length > 0 || getContextRounds(lastTurnContext.history).length > 0
                : getContextRounds(lastTurnContext.history).length > 0
            if (hasCompactable) {
              const priorCheckpoint = findActiveCheckpoint(
                lastTurnContext.history,
                host.getSession(sessionId)?.checkpoints,
                toolRound > 0 ? reply.id : undefined
              )
              const policy = computeCompactionPolicy(host.provider.modelSpec(lastTurnContext.model))
              const estimatedBefore = Math.max(
                policy.ceiling,
                estimateMessagesTokens(
                  toRequestMessages(lastTurnContext.history, lastTurnContext.question, {
                    checkpoint: priorCheckpoint ?? undefined,
                    environmentContext: resolveEnvironmentContext(reply),
                    inProgress: toolRound > 0 ? reply : undefined,
                    clientTools: lastTurnContext.declaredClientNames,
                    providerId: host.provider.id,
                    inlineBlobs: lastTurnContext.inlineBlobs,
                    inlineToolImages: !host.provider.attachments,
                  }),
                  lastTurnContext.system,
                  lastTurnContext.tools
                )
              )
              const compResult = await performCompaction({
                trigger: 'overflow',
                model: lastTurnContext.model,
                system: lastTurnContext.system,
                tools: lastTurnContext.tools,
                history: lastTurnContext.history,
                question: lastTurnContext.question,
                inProgressReply: toolRound > 0 ? reply : undefined,
                priorCheckpoint: priorCheckpoint ?? undefined,
                declaredClientNames: lastTurnContext.declaredClientNames,
                inlineBlobs: lastTurnContext.inlineBlobs,
                environmentContext: resolveEnvironmentContext(reply),
                includeInProgressThinking:
                  Boolean(initial.thinking) &&
                  (reply.provider ?? host.provider.id) === host.provider.id &&
                  (reply.model ?? lastTurnContext.model) === lastTurnContext.model,
                tokensBefore: estimatedBefore,
              })
              if (compResult.kind === 'cancelled' || controller.signal.aborted) {
                settleTurnHooks('user')
                reply = settleReply(reply, 'stopped', Date.now())
                break
              }
              if (compResult.kind === 'compacted') {
                attempt -= 1
                continue
              }
            }
          }
          if (error instanceof ApiError) {
            reply = settleReply(reply, 'error', Date.now(), {
              kind: error.kind,
              message: error.message,
              status: error.status,
              localMessage: error.localMessage,
            })
          } else {
            reply = settleReply(reply, 'error', Date.now(), {
              kind: 'protocol',
              message: error instanceof Error ? error.message : String(error),
            })
          }
          break
        }
      }
    } finally {
      const reason = settledByRoundLimit
        ? 'roundLimit'
        : reply.status === 'done'
          ? 'done'
          : controller.signal.aborted
            ? 'user'
            : 'interrupted'
      settleTurnHooks(reason)
      host.registerFlush(sessionId, null)
      cancelAnimationFrame(frame)
      host.updateReply(sessionId, reply)
      host.setCompacting(sessionId, false)
      host.setStreaming(sessionId, null)
      host.persist(sessionId)
      host.log.publish<ReplyLifecycleChanged>({
        type: 'ReplyLifecycleChanged',
        sessionId,
        messageId: reply.id,
        phase: 'settled',
      })
      if (
        reply.status === 'done' &&
        reply.stopReason !== 'refusal' &&
        !controller.signal.aborted &&
        lastTurnContext
      ) {
        host.onAutoTitle({ sessionId, epoch, reply, ...lastTurnContext })
      }
    }
  }

  return { streamReply }
}
