import type {
  ApiErrorKind,
  MessageUsage,
  ModelId,
  ProviderId,
  StopDetails,
  StopReason,
} from '@deepseek-chat/lib-agent'
import type { CitedSourceMeta, DeliveredFileRef } from '@deepseek-chat/lib-tools'
import type { BlobEntry } from '@deepseek-chat/spine/ports'

/**
 * Persisted user file attachment metadata. `id` is the local key in Spine `BlobStore`; `serverId`
 * is an optional provider-scoped remote file reference cached for upload-backed providers.
 */
export type ArchiveFileAttachment = {
  id: string
  serverId: string | null
  /** Provider ID that issued `serverId` (`undefined` treated as `'deepseek'` for legacy sessions). */
  serverProvider?: ProviderId | null
  name: string
  size: number
  isImage: boolean
  mimeType: string
}

/** Message tree links; omitted fields normalize as a single linear branch. */
export type ArchiveBranchLinks = {
  parentId?: string | null
  selectedChildId?: string
}

export type ArchiveUserMessage = ArchiveBranchLinks & {
  id: string
  role: 'user'
  content: string
  files: ArchiveFileAttachment[]
  createdAt: number
}

export type ArchiveThinkingPart = {
  type: 'thinking'
  thinking: string
  signature?: string
  startedAt?: number
  endedAt?: number
  elapsedSeconds?: number
}

export type ArchiveTextPart = {
  type: 'text'
  text: string
  /** Local template/notice text (e.g. imported refusal or error notice); excluded from model context. */
  isTemplate?: boolean
}

export type ArchiveToolCallPart = {
  type: 'tool_use'
  id: string
  name: string
  input: unknown
  inputJson?: string
}

export type ArchiveToolResultPart = {
  type: 'tool_result'
  tool_use_id: string
  capability?: string
  content: string
  status: 'running' | 'ok' | 'error' | 'aborted'
  files?: DeliveredFileRef[]
  sources?: CitedSourceMeta[]
  /** Legacy persisted field read during export of pre-client-tool sessions. */
  searchResults?: CitedSourceMeta[]
  payload?: unknown
}

export type ArchiveReplyBlock =
  | ArchiveThinkingPart
  | ArchiveTextPart
  | ArchiveToolCallPart
  | ArchiveToolResultPart

export type ArchiveReplyStatus = 'pending' | 'streaming' | 'done' | 'stopped' | 'error'

export type ArchiveReplyError = {
  kind: ApiErrorKind | 'upload'
  message: string
  status?: number
  localMessage?: { key: string; params?: Record<string, string | number> }
  retryable?: boolean
}

export type ArchiveAssistantMessage = ArchiveBranchLinks & {
  id: string
  role: 'assistant'
  createdAt: number
  /** Model ID used for this reply, or null when unknown (e.g. imported history). */
  model: ModelId | null
  /** Provider ID that produced this reply (used to guard thinking-block replay provenance). */
  provider?: ProviderId | null
  thinking?: boolean
  /** Legacy persisted flag read during export of pre-capability sessions. */
  search?: boolean
  enabledCapabilities?: Record<string, boolean>
  /** Deprecated legacy prefill marker retained optionally for stored sessions. */
  prefix?: boolean
  status: ArchiveReplyStatus
  blocks: ArchiveReplyBlock[]
  stopReason?: StopReason
  stopDetails?: StopDetails
  usage?: MessageUsage
  error?: ArchiveReplyError
}

export type ArchiveMessage = ArchiveUserMessage | ArchiveAssistantMessage

export type ArchiveSession = {
  id: string
  title: string
  titleLocked?: boolean
  createdAt: number
  updatedAt: number
  messages: ArchiveMessage[]
  rootMessageId?: string | null
}

export type ArchiveSessionSummary = Pick<ArchiveSession, 'id' | 'title' | 'createdAt' | 'updatedAt'>

/** Narrow bidirectional history port connecting `slices/conversations` and `slices/history-backup`. */
export type ChatArchiveSessionsPort = {
  snapshotForExport(): {
    readonly summaries: readonly ArchiveSessionSummary[]
    readonly loadSession: (id: string) => Promise<ArchiveSession | undefined>
  }
  replaceHistory(
    prepare: () => Promise<{
      readonly sessions: readonly ArchiveSession[]
      readonly blobs: readonly BlobEntry[]
    }>
  ): Promise<number>
  useState(): { readonly replacing: boolean; readonly empty: boolean }
  describeReplyNotice?(message: ArchiveAssistantMessage): string | null
}
