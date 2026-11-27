import type {
  ApiErrorKind,
  MessageUsage,
  ModelId,
  ProviderId,
  StopDetails,
  StopReason,
} from '@deepseek-chat/lib-agent'
import type {
  CitedSourceMeta,
  DeliveredFileRef,
  FrontStageNote,
  ToolProgress,
} from '@deepseek-chat/lib-tools'

/**
 * User file attachment. `id` is the neutral local key in `BlobStore`; `serverId` is an optional
 * provider-scoped remote file reference cached for upload-backed providers (e.g. DeepSeek Files API).
 */
export type FileAttachment = {
  id: string
  serverId: string | null
  /** Provider ID that issued `serverId` (`undefined` treated as `'deepseek'` for legacy sessions). */
  serverProvider?: ProviderId | null
  name: string
  size: number
  isImage: boolean
  mimeType: string
}

/** Branching pointers; omitted fields are normalized as a single linear branch. */
type MessageBranch = {
  parentId?: string | null
  selectedChildId?: string
}

export type UserMessage = MessageBranch & {
  id: string
  role: 'user'
  content: string
  files: FileAttachment[]
  createdAt: number
}

export type ThinkingPart = {
  type: 'thinking'
  thinking: string
  signature?: string
  startedAt?: number
  endedAt?: number
  elapsedSeconds?: number
}

export type TextPart = {
  type: 'text'
  text: string
  /** Local template/notice text (e.g. imported refusal or error notice); excluded from model context. */
  isTemplate?: boolean
}

export type ToolCallPart = {
  type: 'tool_use'
  id: string
  name: string
  input: unknown
  inputJson?: string
}

export type ToolResultPart = {
  type: 'tool_result'
  tool_use_id: string
  capability?: string
  content: string
  status: 'running' | 'ok' | 'error' | 'aborted'
  progress?: ToolProgress
  startedAt?: number
  durationMs?: number
  images?: string[]
  previewImages?: string[]
  files?: DeliveredFileRef[]
  imageFileIds?: (string | null)[]
  sources?: CitedSourceMeta[]
  frontStageNote?: FrontStageNote
  payload?: unknown
}

export type ReplyBlock = ThinkingPart | TextPart | ToolCallPart | ToolResultPart

export type ReplyStatus = 'pending' | 'streaming' | 'done' | 'stopped' | 'error'

export type AssistantMessage = MessageBranch & {
  id: string
  role: 'assistant'
  createdAt: number
  /** Model ID used for this reply, or null when unknown (e.g. imported history). */
  model: ModelId | null
  /** Provider ID that produced this reply (used to guard thinking-block replay provenance). */
  provider?: ProviderId | null
  thinking?: boolean
  enabledCapabilities?: Record<string, boolean>
  capabilityState?: Record<string, unknown>
  /** Dynamic `<environment_context>` snapshot active on this turn. */
  environmentContext?: string
  /** Legacy persisted CSV reminder from older sessions; normalized via `resolveEnvironmentContext`. */
  latestReminder?: string
  /** Deprecated legacy prefill marker retained optionally for stored sessions. */
  prefix?: boolean
  status: ReplyStatus
  blocks: ReplyBlock[]
  stopReason?: StopReason
  stopDetails?: StopDetails
  usage?: MessageUsage
  error?: {
    kind: ApiErrorKind | 'upload'
    message: string
    status?: number
    localMessage?: { key: string; params?: Record<string, string | number> }
    retryable?: boolean
  }
}

export type Message = UserMessage | AssistantMessage

export type CompactionTrigger = 'turnStart' | 'betweenRounds' | 'manual' | 'fit' | 'overflow'

export type CompactionCheckpoint = {
  readonly id: string
  /** Last visible-branch message covered by this checkpoint. */
  readonly anchorMessageId: string
  /** Set only for mid-turn compactions: covers `reply.blocks[0..afterBlockIndex]` inclusive. */
  readonly afterBlockIndex?: number
  readonly trigger: CompactionTrigger
  readonly createdAt: number
  /** Frozen wire text sent to the model (immutable across turns and reloads for KV-cache reuse). */
  readonly renderedWireText: string
  /** Model-written summary markdown shown when the user expands the transcript divider. */
  readonly summary: string
  readonly keptMessagesCount: number
  readonly droppedMessagesCount: number
  readonly droppedReasoning: boolean
  readonly tokensBefore: number
  readonly tokensAfter: number
}

export type Session = {
  id: string
  title: string
  titleLocked?: boolean
  createdAt: number
  updatedAt: number
  messages: Message[]
  rootMessageId?: string | null
  checkpoints?: CompactionCheckpoint[]
}

export type SessionSummary = Pick<Session, 'id' | 'title' | 'createdAt' | 'updatedAt'>

export const toSessionSummary = (session: SessionSummary): SessionSummary => ({
  id: session.id,
  title: session.title,
  createdAt: session.createdAt,
  updatedAt: session.updatedAt,
})
