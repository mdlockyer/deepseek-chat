/**
 * Conversations: chats, their branches and replies, provider-neutral messaging, attachments and
 * drafts, the composer, the session list, factory-scoped persistence, and the chat's views.
 *
 * Domain-blind to every sibling capability slice: all tool execution, toggles, work-strip
 * summaries, and lifecycle hooks flow through the open `ToolRegistry` contract.
 */
import type { ReactNode } from 'react'
import {
  SiteLogo,
  SourceCard,
  buildActivityTimeline,
  extractTurnSources,
  type ActivityFailedStep,
  type ActivityFileItem,
  type ActivityLanePhase,
  type ActivitySelection,
  type ActivitySource,
  type ActivityStepRecord,
  type ActivityTab,
  type ActivityTarget,
  type ActivityThinkingRound,
  type ActivityTimeline,
  type ActivityTimelinePhase,
  type ActivityVisualItem,
  type ExtractedTurnSources,
  type SessionTurnSummary,
  type TurnSnapshot,
} from '../cells/activity-inspector/index.js'
import { bindView } from './context.js'
import { describeReply } from './describe.js'
import { createConversationsRuntime, type ConversationsDeps } from './runtime.js'
import { ChatMain, ChatSaveBanner, createChatHooks } from './ui/session/ChatMain.js'
import { SiderToolbar } from './ui/sider/SiderToolbar.js'
import { MobileSider, Sider } from './ui/sider/Sider.js'

export {
  DEFAULT_CONVERSATIONS_PARAMS,
  type ConversationsDeps,
  type ConversationsParams,
} from './runtime.js'
export { SiteLogo, SourceCard, buildActivityTimeline, extractTurnSources }
export type {
  ActivityFailedStep,
  ActivityFileItem,
  ActivityLanePhase,
  ActivitySelection,
  ActivitySource,
  ActivityStepRecord,
  ActivityTab,
  ActivityTarget,
  ActivityThinkingRound,
  ActivityTimeline,
  ActivityTimelinePhase,
  ActivityVisualItem,
  ExtractedTurnSources,
  SessionTurnSummary,
  TurnSnapshot,
}
export { createIndexedDbSessionStore, type SessionStore } from './sessionStore.js'
export type { ReadingCause, ReadingPosition, RevealRequest } from './reading.js'
export type { StreamTrace, StreamTraceBlock } from './streamTrace.js'
export type {
  ChatFile,
  ConversationsViewDeps,
  SettingsSection,
  SiderMode,
  VoiceViews,
} from './views.js'
export type { ClientTool } from '@deepseek-chat/lib-agent'
export type {
  AssistantMessage,
  CompactionCheckpoint,
  CompactionTrigger,
  FileAttachment,
  Message,
  ReplyBlock,
  Session,
  SessionSummary,
  ThinkingPart,
  ToolCallPart,
  ToolResultPart,
  UserMessage,
} from './types.js'

export type AttachRefusal = {
  readonly key: string
  readonly params?: Record<string, string | number>
}

export const createConversationsSlice = (deps: ConversationsDeps) => {
  const runtime = createConversationsRuntime(deps)
  const { useChatLifecycle, useActiveSessionId } = createChatHooks(runtime)

  const BoundSider = bindView(runtime, Sider)
  const BoundMobileSider = bindView(runtime, MobileSider)
  const BoundSiderToolbar = bindView(runtime, SiderToolbar)
  const BoundChatMain = bindView(runtime, ChatMain)
  const BoundChatSaveBanner = bindView(runtime, ChatSaveBanner)
  const ActivityPanel: (props?: { topActions?: ReactNode }) => ReactNode =
    runtime.activity?.ActivityPanel ?? (() => null)

  return {
    /** Stops the chat's reply in progress, if any. */
    stopReply: runtime.stopReply,

    /**
     * Headless commands: the same operations the views perform. `null` as a session id is the
     * new-chat screen.
     */
    commands: {
      /** Loads the session list; resolves when ready (or failed). */
      init: runtime.initChat,
      newChat: runtime.newChat,
      selectSession: runtime.selectSession,
      renameSession: runtime.renameSession,
      /** Resolves `true` once the chat is deleted from storage. */
      removeSession: runtime.removeSession,
      setDraft: runtime.drafts.setDraftText,
      /**
       * Adds files to the chat's draft and starts uploading them, as the composer does. Returns the
       * reason the batch was refused (count, size, type), or `null`. Until every upload has finished,
       * `send` sends nothing and returns `false`.
       */
      attach: (sessionId: string | null, files: File[]): AttachRefusal | null =>
        runtime.drafts.addDraftFiles(sessionId, files),
      /** Sends the chat's draft; `false` when nothing was sent. */
      send: runtime.sendMessage,
      regenerate: runtime.regenerateReply,
      /** Continues a stopped or interrupted reply (resuming tool loops when applicable). */
      continueReply: runtime.continueReply,
      /** Edits a question into a new version and replies to it; `false` when refused. */
      edit: runtime.editMessage,
      selectVersion: runtime.selectMessageVersion,
      /** Manually compacts earlier history on the active visible branch into a checkpoint. */
      compact: runtime.compactSession,
      /** Resolves when that chat (or every chat) has no reply or compaction in progress. */
      whenIdle: runtime.waitForIdle,
    },

    /** The session list (newest first), the chat on screen, and which chats are replying. */
    getState: () => {
      const { ready, sessions, activeId, streaming } = runtime.useChatStore.getState()
      return { ready, sessions, activeId, replying: Object.keys(streaming) }
    },

    /** Notifies listeners whenever session readiness, list, active selection, or streaming state changes. */
    subscribe: (listener: () => void) => runtime.useChatStore.subscribe(() => listener()),

    /** Instance-scoped DeepThink toggle (`chat-demo:thinking`). */
    getThinking: () => runtime.useThinkingStore.getState().thinking,
    setThinking: runtime.setThinking,

    /** A loaded chat's visible branch; the React hook re-renders on change. */
    getChatMessages: runtime.getChatMessages,
    getChatCheckpoints: runtime.getChatCheckpoints,
    useChatMessages: runtime.useChatMessages,

    /** Referentially stable read-only live turn snapshot for a loaded assistant reply. */
    getTurnSnapshot: runtime.getTurnSnapshot,

    /** Built-in Activity & Sources inspector cell (non-null when `activityPanel` is provided). */
    activity: runtime.activity
      ? {
          togglePanel: runtime.activity.togglePanel,
          inspectTurn: runtime.requestTurnInspection,
          selectTurn: runtime.activity.selectTurn,
          useActiveTarget: runtime.activity.useActiveTarget,
          getSelection: runtime.activity.getSelection,
          getTarget: runtime.activity.getTarget,
          close: runtime.activity.close,
          setReadingPosition: runtime.reading.setReadingPosition,
          getRevealRequest: () => runtime.reading.useReadingStore.getState().reveal,
        }
      : null,

    // Storage ports consumed by `slices/history-backup` via app composition.
    snapshotForExport: runtime.snapshotForExport,
    replaceSessions: runtime.replaceSessions,
    useHistoryState: runtime.useHistoryState,
    describeReplyNotice: (message: Parameters<typeof describeReply>[0]): string | null =>
      describeReply(message, runtime.getLocale())?.text ?? null,

    // Views and their lifecycle.
    /** Call once from the app shell, outside any error boundary. */
    useChatLifecycle,
    useActiveSessionId,
    Sider: BoundSider,
    MobileSider: BoundMobileSider,
    SiderToolbar: BoundSiderToolbar,
    ChatMain: BoundChatMain,
    ChatSaveBanner: BoundChatSaveBanner,
    ActivityPanel,

    /** Tears down streams, timers, EventLog listeners, and owned DB handles. */
    dispose: runtime.dispose,
  }
}

export type ConversationsSlice = ReturnType<typeof createConversationsSlice>

// ---------- Pure model functions (also the boundary tests' surface) ----------

export { ApiError, requestWith } from './apiClient.js'
export {
  AUTO_TITLE_KEEP,
  MAX_AUTO_TITLE_CHARS,
  buildAutoTitlePrompt,
  buildAutoTitleRequest,
  parseAutoTitleResponse,
} from './autoTitle.js'
export { ServerSentEventDecoder, readServerSentEvents } from '@deepseek-chat/lib-agent'
export { appendBranch, getVisibleMessages, normalizeSession, selectVersion } from './branches.js'
export {
  CONTINUE_PROMPT,
  applyEvent,
  canContinueReply,
  findActiveCheckpoint,
  pickImageResults,
  settleReply,
  toHistoryPrefixMessages,
  toRequestMessages,
  type InlineAttachmentData,
  type ToRequestMessagesOptions,
} from './reply.js'
export {
  computeCompactionPolicy,
  selectCompactionTrigger,
  type CompactionPolicy,
} from './compaction/budget.js'
export {
  runCompaction,
  type CompactionResult,
  type RunCompactionParams,
} from './compaction/compact.js'
export {
  estimateAttachmentTokens,
  estimateMessagesTokens,
  estimateSessionContext,
  estimateTextTokens,
  type SessionContextEstimate,
} from './compaction/estimate.js'
export { buildCompactionLedgerText } from './compaction/ledger.js'
export {
  CHECKPOINT_ACK,
  buildChunkedCompactionPrompt,
  buildCompactionInstruction,
  renderCheckpointWireText,
  validateCompactionSummary,
} from './compaction/prompts.js'
export { buildVerbatimSection, type VerbatimSelection } from './compaction/verbatim.js'
export {
  createEnvironmentContext,
  formatLegacyLatestReminder,
  resolveEnvironmentContext,
} from './environmentContext.js'
export { collectCitedUrls } from './citations.js'
export {
  buildReplyView,
  getAreaTitle,
  getTotalThinkingSeconds,
  holdsNarration,
  NARRATION_HOLD_MS,
  NARRATION_MAX_CHARS,
  needsWorkingIndicator,
  showsRunning,
  type ReplyView,
  type Source,
  type Step,
  type ToolStep,
} from './view.js'
export {
  INLINE_TRACE_PREVIEW_LIMIT,
  buildInlineTrace,
  buildTurnWorkStrip,
  getFrontStageNotes,
  selectInlineTracePreview,
  type FrontStageNoteEntry,
  type InlineTrace,
  type InlineTraceItem,
  type InlineTracePreview,
  type InlineTracePreviewEntry,
  type TurnWorkStripState,
} from './workStrip.js'
