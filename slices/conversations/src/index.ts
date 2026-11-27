/**
 * Conversations: chats, their branches and replies, provider-neutral messaging, attachments and
 * drafts, the composer, the session list, factory-scoped persistence, and the chat's views.
 *
 * Domain-blind to every sibling capability slice: all tool execution, toggles, work-strip
 * summaries, and lifecycle hooks flow through the open `ToolRegistry` contract.
 */
import type { ReactNode } from 'react'
import {
  buildActivityTimeline,
  extractTurnSources,
  type ActivitySelection,
  type ActivityTarget,
  type TurnSnapshot,
} from '../cells/activity-inspector/index.js'
import {
  ChatMain,
  ChatSaveBanner,
  MobileSider,
  Sider,
  SiderToolbar,
  bindView,
  createChatHooks,
  describeReply,
} from '../cells/views/index.js'
import { isHistoryReady, replyingSessionIds } from '../kernel/index.js'
import { createConversationsRuntime, type ConversationsDeps } from './runtime.js'

export type { ConversationsDeps, ConversationsParams } from './runtime.js'
export {
  buildActivityTimeline,
  extractTurnSources,
  type ActivitySelection,
  type ActivityTarget,
  type TurnSnapshot,
}
export { createIndexedDbSessionStore, type SessionStore } from '../cells/storage/index.js'
export type { ReadingCause, RevealRequest } from '../kernel/index.js'
export type { StreamTrace } from '../cells/turn-loop/index.js'
export type { ChatFile, SettingsSection, SiderMode } from '../cells/views/index.js'
export type {
  AssistantMessage,
  CompactionCheckpoint,
  Message,
  Session,
  SessionSummary,
  UserMessage,
} from '../kernel/index.js'

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
      const state = runtime.useChatStore.getState()
      return {
        ready: isHistoryReady(state),
        sessions: [...state.sessions],
        activeId: state.activeId,
        replying: replyingSessionIds(state),
      }
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
          getRevealRequest: runtime.reading.getRevealRequest,
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

// ---------- Pure model functions (documented contract & boundary tests' surface) ----------

export {
  appendBranch,
  getVisibleMessages,
  normalizeSession,
  selectVersion,
} from '../kernel/index.js'
export {
  CONTINUE_PROMPT,
  applyEvent,
  canContinueReply,
  findActiveCheckpoint,
  pickImageResults,
  settleReply,
  toRequestMessages,
} from '../kernel/index.js'
export { computeCompactionPolicy, selectCompactionTrigger } from '../kernel/index.js'
export {
  CHECKPOINT_ACK,
  buildCompactionLedgerText,
  buildVerbatimSection,
  estimateSessionContext,
  estimateTextTokens,
  validateCompactionSummary,
} from '../cells/compaction/index.js'
export { formatLegacyLatestReminder } from '../kernel/index.js'
export {
  buildInlineTrace,
  buildReplyView,
  buildTurnWorkStrip,
  getAreaTitle,
  getFrontStageNotes,
  holdsNarration,
  needsWorkingIndicator,
  selectInlineTracePreview,
  type InlineTraceItem,
} from '../cells/views/index.js'
