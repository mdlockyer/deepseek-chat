export {
  ConversationsProvider,
  bindView,
  useConversations,
  type ActivityTargetRef,
  type ConversationsViewRuntime,
} from './context.js'
export { describeReply } from './describe.js'
export { createReadingPositions } from './reading.js'
export { groupSessions } from './sessionGroups.js'
export { ChatMain, ChatSaveBanner, createChatHooks } from './ui/session/ChatMain.js'
export { MobileSider, Sider } from './ui/sider/Sider.js'
export { SiderToolbar } from './ui/sider/SiderToolbar.js'
export {
  NARRATION_HOLD_MS,
  NARRATION_MAX_CHARS,
  buildReplyView,
  getAreaTitle,
  getTotalThinkingSeconds,
  holdsNarration,
  needsWorkingIndicator,
  showsRunning,
  type ReplyView,
  type Source,
  type Step,
  type ToolStep,
} from './view.js'
export type {
  ChatFile,
  ConversationsViewDeps,
  SettingsSection,
  SiderMode,
  VoiceViews,
} from './views.js'
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
