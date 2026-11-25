import type { SessionDeleted, SessionHistoryReplaced } from '@deepseek-chat/spine/facts/session'
import { noopNoticePort, type NoticePort, type PanelSlot } from '@deepseek-chat/spine/ports'
import type { EventLog } from '@deepseek-chat/spine/runtime'
import type { PreviewHost, WorkspaceViews } from './context.js'
import { createPreviewPanel } from './PreviewPanel.js'
import { createPreviewState, type PreviewViewMode, type SessionPreviewState } from './state.js'
import {
  PREVIEW_TOOL_INSTRUCTIONS,
  PREVIEW_TOOL_NAMES,
  PREVIEW_TOOLS,
  runPreviewTool,
  type FileToolDefinition,
  type PreviewToolRunResult,
} from './tools.js'
import type { FileRecord } from './workspace.js'

export type { PreviewBounds, PreviewHost, WorkspaceViews } from './context.js'
export type { PreviewViewMode, SessionPreviewState } from './state.js'
export type { FileToolDefinition, PreviewToolRunResult } from './tools.js'
export type {
  FileRecord,
  FileVersionEntry,
  PresentedFile,
  WorkspaceArtifact,
  WorkspaceFileSource,
} from './workspace.js'
export { EMPTY_SESSION_PREVIEW_STATE } from './state.js'
/** File-format rules (pure): MIME inference, preview kind, highlight language, CSV/TSV parsing. */
export {
  classifyPreviewKind,
  getCodeLanguage,
  inferMimeType,
  parseDelimitedText,
  supportsPreviewToggle,
  type PreviewKind,
} from './fileKinds.js'
export {
  collectWorkspaceArtifacts,
  makeArtifactKey,
  makeUploadPreviewKey,
  normalizeWorkspacePath,
} from './workspace.js'
/** Tool names persisted in chat history; never rename. */
export {
  EDIT_FILE_TOOL_NAME,
  PREVIEW_TOOL_NAMES as FILE_TOOL_NAMES,
  PRESENT_FILE_TOOL_NAME,
  READ_FILE_TOOL_NAME,
} from './tools.js'

export type WorkspaceFilesDeps = {
  readonly log: EventLog
  /** This slice's slot in the app's right-hand panel. */
  readonly panel: PanelSlot
  /** Desktop isolated preview webview; `null` on the web (iframe / built-in PDF viewer). */
  readonly host: PreviewHost | null
  /** Stored file contents by id. */
  readonly loadFile: (fileId: string) => Promise<Blob | undefined>
  /** Saves a file for the user (desktop: save dialog; web: download). */
  readonly saveFile: (name: string, blob: Blob) => Promise<void>
  readonly copyText: (text: string) => Promise<boolean>
  readonly views: WorkspaceViews
  /** Ephemeral user feedback port; defaults to a safe no-op for headless callers. */
  readonly notify?: NoticePort
  readonly newId?: () => string
}

export const createWorkspaceFilesSlice = (deps: WorkspaceFilesDeps) => {
  const state = createPreviewState(deps.panel)
  const notify = deps.notify ?? noopNoticePort
  const newId = deps.newId ?? (() => crypto.randomUUID())

  const unsubscribers = [
    deps.log.subscribe<SessionDeleted>('SessionDeleted', ({ fact }) => {
      state.disposeSessionPreview(fact.sessionId)
    }),
    deps.log.subscribe<SessionHistoryReplaced>('SessionHistoryReplaced', () => {
      state.clearAllSessionPreviews()
    }),
  ]

  return {
    toolNames: PREVIEW_TOOL_NAMES,
    instructions: PREVIEW_TOOL_INSTRUCTIONS,
    /** The file tools are offered on every turn. */
    declareTools: (): FileToolDefinition[] => PREVIEW_TOOLS,
    handles: (toolName: string) => PREVIEW_TOOL_NAMES.has(toolName),
    /**
     * Run one file tool against the chat's files. Always resolves. A presented or edited file comes
     * back as `file` for the caller to store, then `reveal`.
     */
    run: (
      toolName: string,
      input: unknown,
      options: { records: readonly FileRecord[]; replyId: string }
    ): Promise<PreviewToolRunResult> =>
      runPreviewTool(toolName, input, {
        records: options.records,
        replyId: options.replyId,
        loadFile: deps.loadFile,
        newId,
      }),

    /** Show a newly stored file (opens the panel when that chat is on screen, unless told). */
    reveal: (
      sessionId: string,
      key: string,
      options?: { openPanel?: boolean; defaultMode?: PreviewViewMode }
    ) => state.revealPresentedFile(sessionId, key, options),
    /** The user opened a file card: show it (a specific version when not the latest). */
    openFile: state.openPreviewFile,
    togglePanel: state.togglePreviewPanel,
    closePanel: state.closePreviewPanel,
    getSession: (sessionId: string): SessionPreviewState =>
      state.getSessionPreview(state.usePreviewStore.getState(), sessionId),
    /** React: a chat's preview state. */
    useSession: (sessionId: string | null): SessionPreviewState =>
      state.usePreviewStore((current) => state.getSessionPreview(current, sessionId)),
    /** Refreshes the still image shown while the native preview is hidden. */
    refreshSnapshot: state.triggerNativePreviewSnapshot,

    PreviewPanel: createPreviewPanel({
      state,
      panel: deps.panel,
      host: deps.host,
      views: deps.views,
      loadFile: deps.loadFile,
      saveFile: deps.saveFile,
      copyText: deps.copyText,
      notify,
    }),
    dispose: () => {
      for (const unsubscribe of unsubscribers) {
        unsubscribe()
      }
    },
  }
}

export type WorkspaceFilesSlice = ReturnType<typeof createWorkspaceFilesSlice>
