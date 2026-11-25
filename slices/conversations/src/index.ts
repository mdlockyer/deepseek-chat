/**
 * Conversations: chats, their branches and replies, the DeepSeek API client, attachments and
 * drafts, the composer, the session list, factory-scoped persistence, and the chat's views.
 *
 * Domain-blind to every sibling capability slice: all tool execution, toggles, work-strip
 * summaries, and lifecycle hooks flow through the open `ToolRegistry` contract.
 */
import { bindView } from './context.js'
import { describeReply } from './describe.js'
import { createConversationsRuntime, type ConversationsDeps } from './runtime.js'
import { ChatMain, ChatSaveBanner, createChatHooks } from './ui/session/ChatMain.js'
import { CollapsedSider } from './ui/sider/CollapsedSider.js'
import { MobileSider, Sider } from './ui/sider/Sider.js'

export {
  DEFAULT_CONVERSATIONS_PARAMS,
  type ConversationsDeps,
  type ConversationsParams,
  type SessionTurnSummary,
  type TurnSnapshot,
} from './runtime.js'
export {
  createIndexedDbSessionStore,
  memorySessionStore,
  type SessionStore,
} from './sessionStore.js'
export type { StreamTrace, StreamTraceBlock } from './streamTrace.js'
export type {
  ChatFile,
  CollapsedTransition,
  ConversationsViewDeps,
  InspectionTarget,
  SettingsSection,
  SiderMode,
  VoiceViews,
} from './views.js'
export type { ClientTool } from '@deepseek-chat/lib-agent'
export type {
  AssistantMessage,
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

export const createConversationsSlice = (deps: ConversationsDeps) => {
  const runtime = createConversationsRuntime(deps)
  const { useChatLifecycle, useActiveSessionId } = createChatHooks(runtime)

  const BoundSider = bindView(runtime, Sider)
  const BoundMobileSider = bindView(runtime, MobileSider)
  const BoundCollapsedSider = bindView(runtime, CollapsedSider)
  const BoundChatMain = bindView(runtime, ChatMain)
  const BoundChatSaveBanner = bindView(runtime, ChatSaveBanner)

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
      attach: (sessionId: string | null, files: File[]) =>
        runtime.drafts.addDraftFiles(sessionId, files, deps.getApiKey() ?? ''),
      /** Sends the chat's draft; `false` when nothing was sent. */
      send: runtime.sendMessage,
      regenerate: runtime.regenerateReply,
      /** Continues a stopped or interrupted reply (resuming tool loops when applicable). */
      continueReply: runtime.continueReply,
      /** Edits a question into a new version and replies to it; `false` when refused. */
      edit: runtime.editMessage,
      selectVersion: runtime.selectMessageVersion,
      /** Resolves when that chat (or every chat) has no reply in progress. */
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
    useChatMessages: runtime.useChatMessages,

    /** Narrow read-only turn snapshot source consumed by `slices/activity-inspector`. */
    getTurnSnapshot: runtime.getTurnSnapshot,
    listSessionTurns: runtime.listSessionTurns,
    subscribeToTurns: runtime.subscribeToTurns,

    // Storage ports consumed by `slices/history-backup` via app composition.
    snapshotForExport: runtime.snapshotForExport,
    replaceSessions: runtime.replaceSessions,
    useHistoryState: runtime.useHistoryState,
    describeReplyNotice: (message: Parameters<typeof describeReply>[0]): string | null =>
      describeReply(message)?.text ?? null,

    /** Instance-scoped DeepSeek HTTP client helper. */
    request: runtime.apiClient.request,

    // Views and their lifecycle.
    /** Call once from the app shell, outside any error boundary. */
    useChatLifecycle,
    useActiveSessionId,
    Sider: BoundSider,
    MobileSider: BoundMobileSider,
    CollapsedSider: BoundCollapsedSider,
    ChatMain: BoundChatMain,
    ChatSaveBanner: BoundChatSaveBanner,

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
  applyEvent,
  canContinueReply,
  pickImageResults,
  settleReply,
  toRequestMessages,
} from './reply.js'
export { collectCitedUrls } from './citations.js'
export {
  buildReplyView,
  getAreaTitle,
  getTotalThinkingSeconds,
  needsWorkingIndicator,
  showsRunning,
  type ReplyView,
  type Source,
  type Step,
  type ToolStep,
} from './view.js'
export {
  buildInlineTrace,
  buildTurnWorkStrip,
  getFrontStageNotes,
  type FrontStageNoteEntry,
  type InlineTrace,
  type InlineTraceItem,
  type TurnWorkStripState,
} from './workStrip.js'
