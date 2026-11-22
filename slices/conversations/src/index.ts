/**
 * Conversations: chats, their branches and replies, the DeepSeek API client, attachments and
 * drafts, the local store (IndexedDB) and history import/export.
 *
 * One instance per app: `createConversationsSlice` installs the ports once at startup.
 */
import { hydrateComposerOptions } from './composerOptions.js'
import { installDeps, type ConversationsDeps } from './env.js'
import { stopReply } from './store.js'

export type { ConversationsDeps } from './env.js'
export type { ToolGateway, ToolKind, ToolResult, ToolRunContext } from './tools.js'

export const createConversationsSlice = (deps: ConversationsDeps) => {
  installDeps(deps)
  hydrateComposerOptions()
  return {
    /** Stops the chat's reply in progress, if any. */
    stopReply,
  }
}

// ---------- Transitional surface: the chat UI still lives in the app tier (src/). ----------

export type { ClientTool } from './api/types.js'
export { ApiError, request } from './api/client.js'
export { ServerSentEventDecoder, readServerSentEvents } from './api/sse.js'
export {
  ACCEPT,
  MAX_COUNT,
  MAX_SIZE_MB,
  formatSize,
  getExtension,
  onUploadNotice,
  useUploads,
  type UploadTask,
} from './attachments.js'
export { BackupError, clearHistory, exportHistory, importHistory } from './backup.js'
export {
  appendBranch,
  buildMessageVersions,
  getVisibleMessages,
  normalizeSession,
  selectVersion,
  type MessageVersions,
} from './branches.js'
export {
  setBrowser,
  setPython,
  setSearch,
  setThinking,
  useComposerOptions,
} from './composerOptions.js'
export { loadFile } from './db.js'
export { describeReply } from './describe.js'
export {
  EMPTY_DRAFT,
  addDraftFiles,
  getDraft,
  prepareDraftMessage,
  removeDraftAttachment,
  retryDraftAttachment,
  setDraftText,
  useDrafts,
  type DraftAttachment,
} from './drafts.js'
export { formatDate, sessionTitle } from './format.js'
export {
  applyEvent,
  canContinueReply,
  pickImageResults,
  settleReply,
  toRequestMessages,
} from './reply.js'
export { groupSessions } from './sessionGroups.js'
export {
  bindChatPersistence,
  continueReply,
  editMessage,
  initChat,
  newChat,
  regenerateReply,
  removeSession,
  renameSession,
  retrySaveSessions,
  retryUpload,
  selectMessageVersion,
  selectSession,
  sendMessage,
  stopReply,
  useChatStore,
} from './store.js'
export type {
  AssistantMessage,
  FileAttachment,
  Message,
  PresentedFileRef,
  ReplyBlock,
  Session,
  SessionSummary,
  ToolCallPart,
  ToolResultPart,
  UserMessage,
  WebSearchSourceMeta,
} from './types.js'
export {
  buildReplyView,
  getAreaTitle,
  isDeepSearchKind,
  isImageSearchKind,
  type BrowserStep,
  type FileStep,
  type FindStep,
  type OpenStep,
  type PageItem,
  type PythonStep,
  type ReadLinkStep,
  type ReplyView,
  type SearchStep,
  type Source,
  type Step,
} from './view.js'

/** History archive codec (pure): the v3 export format's sessions and its ZIP container. */
export { readSessionFile } from './history/schema.js'
export { toSessionFile } from './history/toArchive.js'
export { toLocalSession } from './history/toLocal.js'
export { ArchiveError, readArchive, readEntry } from './history/zipReader.js'
export { writeArchive } from './history/zipWriter.js'

/** This slice's strings, for app-tier views showing its notices and errors (transitional). */
export {
  translate as translateConversations,
  useTranslate as useConversationsTranslate,
  type LinkedMessage as ConversationsNotice,
  type TranslationKey as ConversationsMessageKey,
} from './messages.js'
export { showNotice as showConversationsNotice } from './notice.js'
