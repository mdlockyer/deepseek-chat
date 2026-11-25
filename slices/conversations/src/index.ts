/**
 * Conversations: chats, their branches and replies, the DeepSeek API client, attachments and
 * drafts, the composer, the session list, the local store (IndexedDB), and the chat's views.
 */
import { hydrateComposerOptions } from './composerOptions.js'
import { loadFile } from './db.js'
import { describeReply } from './describe.js'
import { installDeps, type ConversationsDeps } from './env.js'
import { getChatMessages, useChatMessages, useHistoryState } from './sessionAccess.js'
import { addDraftFiles, setDraftText } from './drafts.js'
import {
  continueReply,
  editMessage,
  initChat,
  newChat,
  regenerateReply,
  removeSession,
  renameSession,
  replaceSessions,
  selectMessageVersion,
  selectSession,
  sendMessage,
  snapshotSessionsForExport,
  stopReply,
  useChatStore,
  waitForIdle,
} from './store.js'
import {
  bindActivityPanel,
  restoreLastActivityPanel,
  useActivityPanel,
} from './ui/activity/activityPanelState.js'
import { ActivityPanel } from './ui/activity/ActivityPanel.js'
import {
  ChatMain,
  ChatSaveBanner,
  useActiveSessionId,
  useChatLifecycle,
} from './ui/session/ChatMain.js'
import { CollapsedSider } from './ui/sider/CollapsedSider.js'
import { MobileSider, Sider } from './ui/sider/Sider.js'

export {
  DEFAULT_CONVERSATIONS_PARAMS,
  type ConversationsDeps,
  type ConversationsParams,
} from './env.js'
export type { StreamTrace, StreamTraceBlock } from './streamTrace.js'
export type {
  AgentProfile,
  AgentSource,
  ToolCaller,
  ToolEffect,
  ToolGateway,
  ToolKind,
  ToolResult,
  ToolRunContext,
} from './tools.js'
export type {
  ChatFile,
  ChatPanels,
  ConversationsViewDeps,
  SettingsSection,
  VoiceViews,
} from './views.js'
export type { ClientTool } from '@deepseek-chat/lib-agent'
export type {
  AgentRun,
  AgentRunState,
  AskActionItem,
  AskActionMeta,
  AssistantMessage,
  BoardPost,
  FileAttachment,
  Message,
  PostAudience,
  PostAuthor,
  PresentedFileRef,
  ReplyBlock,
  Session,
  SessionSummary,
  ToolCallPart,
  ToolResultPart,
  UserMessage,
  WebSearchSourceMeta,
} from './types.js'

export const createConversationsSlice = (deps: ConversationsDeps) => {
  installDeps(deps)
  hydrateComposerOptions()
  bindActivityPanel()
  return {
    /** Stops the chat's reply in progress, if any. */
    stopReply,

    /**
     * Headless commands: the same operations the views perform. `null` as a session id is the
     * new-chat screen.
     */
    commands: {
      /** Loads the session list; resolves when ready (or failed). */
      init: initChat,
      newChat,
      selectSession,
      renameSession,
      /** Resolves `true` once the chat is deleted from storage. */
      removeSession,
      setDraft: setDraftText,
      /**
       * Adds files to the chat's draft and starts uploading them, as the composer does. Returns the
       * reason the batch was refused (count, size, type), or `null`. Until every upload has finished,
       * `send` sends nothing and returns `false`.
       */
      attach: (sessionId: string | null, files: File[]) =>
        addDraftFiles(sessionId, files, deps.getApiKey() ?? ''),
      /** Sends the chat's draft; `false` when nothing was sent. */
      send: sendMessage,
      regenerate: regenerateReply,
      /** Continues a stopped or interrupted reply (resuming tool loops when applicable). */
      continueReply,
      /** Edits a question into a new version and replies to it; `false` when refused. */
      edit: editMessage,
      selectVersion: selectMessageVersion,
      /** Resolves when that chat (or every chat) has no reply in progress. */
      whenIdle: waitForIdle,
    },
    /** The session list (newest first), the chat on screen, and which chats are replying. */
    getState: () => {
      const { ready, sessions, activeId, streaming } = useChatStore.getState()
      return { ready, sessions, activeId, replying: Object.keys(streaming) }
    },
    /** Stored file contents (attachments, presented files) by id. */
    loadFile,
    /** A loaded chat's visible branch; the React hook re-renders on change. */
    getChatMessages,
    useChatMessages,

    // Storage ports consumed by slices/history-backup via app composition.
    snapshotForExport: snapshotSessionsForExport,
    replaceSessions,
    useHistoryState,
    describeReplyNotice: (message: Parameters<typeof describeReply>[0]): string | null =>
      describeReply(message)?.text ?? null,

    // Views and their lifecycle.
    /** Call once from the app shell, outside any error boundary. */
    useChatLifecycle,
    useActiveSessionId,
    Sider,
    MobileSider,
    CollapsedSider,
    ChatMain,
    ChatSaveBanner,
    ActivityPanel,
    /** Whether the last inspected turn activity can be restored on this session, and how. */
    useHasLastActivity: () => useActivityPanel((state) => state.lastTarget !== null),
    restoreLastActivityPanel,
  }
}

export type ConversationsSlice = ReturnType<typeof createConversationsSlice>

// ---------- Pure model functions (also the boundary tests' surface) ----------

export { ApiError, request } from './apiClient.js'
export {
  AUTO_TITLE_KEEP,
  MAX_AUTO_TITLE_CHARS,
  buildAutoTitlePrompt,
  buildAutoTitleRequest,
  parseAutoTitleResponse,
} from './autoTitle.js'
export { ServerSentEventDecoder, readServerSentEvents } from '@deepseek-chat/lib-agent'
export { appendBranch, getVisibleMessages, normalizeSession, selectVersion } from './branches.js'
export { setBrowser, setThinking, useComposerOptions } from './composerOptions.js'
export {
  applyEvent,
  canContinueReply,
  pickImageResults,
  settleReply,
  toRequestMessages,
} from './reply.js'
export { POST_TOOL_NAME, WAIT_TOOL_NAME } from './subagentTools.js'
export { assignChildCitations, collectCitedUrls } from './citations.js'
export { buildReplyView, getAreaTitle, needsWorkingIndicator } from './view.js'
export {
  buildActivityTimeline,
  buildTurnWorkStrip,
  getFrontStageAsks,
  type ActivityPhase,
  type ActivityTimeline,
  type LiveAgentTrack,
  type ResearchPhase,
  type SubagentsPhase,
  type TurnWorkStripState,
} from './activityView.js'
