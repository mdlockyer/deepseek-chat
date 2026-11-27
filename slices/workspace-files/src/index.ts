import type {
  ActivityStepEntry,
  CompactionLedgerSection,
  DeliveredFileRef,
  ToolCapability,
} from '@deepseek-chat/lib-tools'
import { IconBrowseOutline16, IconButton } from '@deepseek-chat/lib-ui'
import type {
  SessionDeleted,
  SessionFileDescriptor,
  SessionFilesChanged,
  SessionHistoryReplaced,
  ToolFileDelivered,
} from '@deepseek-chat/spine/facts/session'
import {
  noopNoticePort,
  type BlobStore,
  type NoticePort,
  type PanelSlot,
} from '@deepseek-chat/spine/ports'
import type { EventLog } from '@deepseek-chat/spine/runtime'
import { createElement, useMemo, type ComponentType } from 'react'
import { create } from 'zustand'
import type { PreviewHost, WorkspaceViews } from './context.js'
import headerToggleStyles from './HeaderToggle.module.css'
import { workspaceMessages } from './messages.js'
import { serializeWorkspaceFileForArchive, workspaceFilesPresenter } from './presenter.js'
import { createPreviewPanel } from './PreviewPanel.js'
import { createPreviewState, type PreviewViewMode, type SessionPreviewState } from './state.js'
import {
  PREVIEW_TOOL_INSTRUCTIONS,
  PREVIEW_TOOL_NAMES,
  PREVIEW_TOOLS,
  READ_FILE_TOOL_NAME,
  runPreviewTool,
  type FileToolDefinition,
  type PreviewToolRunResult,
} from './tools.js'
import {
  collectWorkspaceArtifacts,
  makeArtifactKey,
  makeUploadPreviewKey,
  type FileRecord,
} from './workspace.js'

export type { PreviewHost, WorkspaceViews } from './context.js'
export type { PreviewViewMode, SessionPreviewState } from './state.js'
export type { FileToolDefinition, PreviewToolRunResult } from './tools.js'
export type { FileRecord } from './workspace.js'
/** File-format rules (pure): MIME inference, preview kind, highlight language, CSV/TSV parsing. */
export {
  classifyPreviewKind,
  getCodeLanguage,
  inferMimeType,
  parseDelimitedText,
  supportsPreviewToggle,
} from './fileKinds.js'
export {
  collectWorkspaceArtifacts,
  makeArtifactKey,
  makeUploadPreviewKey,
  normalizeWorkspacePath,
} from './workspace.js'

export type WorkspaceFilesDeps = {
  readonly log: EventLog
  /** This slice's slot in the app's right-hand panel. */
  readonly panel: PanelSlot
  /** Desktop isolated preview webview; `null` on the web (iframe / built-in PDF viewer). */
  readonly host: PreviewHost | null
  /** Domain-blind blob store for reading and persisting file bytes. */
  readonly blobs?: BlobStore
  /** Legacy read-only file loader (used when `blobs` is not supplied). */
  readonly loadFile?: (fileId: string) => Promise<Blob | undefined>
  /** Saves a file for the user (desktop: save dialog; web: download). */
  readonly saveFile: (name: string, blob: Blob) => Promise<void>
  readonly copyText: (text: string) => Promise<boolean>
  readonly views: WorkspaceViews
  /** Ephemeral user feedback port; defaults to a safe no-op for headless callers. */
  readonly notify?: NoticePort
  readonly newId?: () => string
}

const EMPTY_FILE_RECORDS: readonly FileRecord[] = []

const toFileRecord = (file: SessionFileDescriptor): FileRecord =>
  file.kind === 'upload'
    ? {
        kind: 'upload',
        fileId: file.fileId,
        name: file.name,
        size: file.size,
        mimeType: file.mimeType,
        messageId: file.messageId,
        createdAt: file.createdAt,
      }
    : {
        kind: 'presented',
        fileId: file.fileId,
        name: file.name,
        ...(file.path ? { path: file.path } : {}),
        ...(file.title ? { title: file.title } : {}),
        size: file.size,
        mimeType: file.mimeType,
        ...(file.version !== undefined ? { version: file.version } : {}),
        source: file.producer === 'python' ? 'python' : 'model',
        ...(file.producedByTool || file.producer
          ? { producedBy: file.producedByTool ?? file.producer }
          : {}),
        messageId: file.messageId,
        createdAt: file.createdAt,
      }

export const createWorkspaceFilesSlice = (deps: WorkspaceFilesDeps) => {
  const state = createPreviewState(deps.panel)
  const notify = deps.notify ?? noopNoticePort
  const newId = deps.newId ?? (() => crypto.randomUUID())
  const blobs = deps.blobs
  const loadFile = blobs
    ? (fileId: string) => blobs.get(fileId)
    : (deps.loadFile ?? (async () => undefined))

  const useFilesBySession = create<{ bySession: Record<string, readonly FileRecord[]> }>(() => ({
    bySession: {},
  }))

  const getRecords = (sessionId: string): readonly FileRecord[] =>
    Object.hasOwn(useFilesBySession.getState().bySession, sessionId)
      ? (useFilesBySession.getState().bySession[sessionId] ?? EMPTY_FILE_RECORDS)
      : EMPTY_FILE_RECORDS

  const useSessionFiles = (sessionId: string | null): readonly FileRecord[] =>
    useFilesBySession((current) =>
      sessionId && Object.hasOwn(current.bySession, sessionId)
        ? (current.bySession[sessionId] ?? EMPTY_FILE_RECORDS)
        : EMPTY_FILE_RECORDS
    )

  const unsubscribers = [
    deps.log.subscribe<SessionFilesChanged>(
      'SessionFilesChanged',
      ({ fact }) => {
        const mapped = fact.files.map(toFileRecord)
        useFilesBySession.setState((current) => ({
          bySession: { ...current.bySession, [fact.sessionId]: mapped },
        }))
      },
      { replaySticky: true }
    ),
    deps.log.subscribe<ToolFileDelivered>('ToolFileDelivered', ({ fact }) => {
      const key = makeArtifactKey(fact.file.path ?? fact.file.name)
      state.revealPresentedFile(fact.sessionId, key, { openPanel: fact.isActiveSession })
    }),
    deps.log.subscribe<SessionDeleted>('SessionDeleted', ({ fact }) => {
      state.disposeSessionPreview(fact.sessionId)
      useFilesBySession.setState((current) => {
        if (!Object.hasOwn(current.bySession, fact.sessionId)) {
          return current
        }
        return {
          bySession: Object.fromEntries(
            Object.entries(current.bySession).filter(([key]) => key !== fact.sessionId)
          ),
        }
      })
    }),
    deps.log.subscribe<SessionHistoryReplaced>('SessionHistoryReplaced', () => {
      state.clearAllSessionPreviews()
      useFilesBySession.setState({ bySession: {} })
    }),
  ]

  const openDeliveredFile = (sessionId: string, file: DeliveredFileRef) => {
    const key = makeArtifactKey(file.path ?? file.name)
    const artifact = collectWorkspaceArtifacts(getRecords(sessionId)).find(
      (item) => item.key === key
    )
    const isLatest = !artifact || artifact.latest.fileId === file.id
    state.openPreviewFile(sessionId, key, file.id, isLatest)
  }

  const openUploadFile = (sessionId: string, fileId: string) => {
    state.openPreviewFile(sessionId, makeUploadPreviewKey(fileId), fileId, true)
  }

  const useIsDeliveredFileShown = (sessionId: string, file: DeliveredFileRef): boolean => {
    const isOpen = deps.panel.useLayout(() => deps.panel.isOpen(sessionId))
    const session = state.usePreviewStore((current) => state.getSessionPreview(current, sessionId))
    const records = useSessionFiles(sessionId)
    if (!isOpen) {
      return false
    }
    const key = makeArtifactKey(file.path ?? file.name)
    if (session.activeKey !== key) {
      return false
    }
    const pinned = session.selectedFileIdByKey[key]
    if (pinned) {
      return pinned === file.id
    }
    const artifact = collectWorkspaceArtifacts(records).find((item) => item.key === key)
    return !artifact || artifact.latest.fileId === file.id
  }

  const useIsUploadFileShown = (sessionId: string, fileId: string): boolean => {
    const isOpen = deps.panel.useLayout(() => deps.panel.isOpen(sessionId))
    const session = state.usePreviewStore((current) => state.getSessionPreview(current, sessionId))
    return isOpen && session.activeKey === makeUploadPreviewKey(fileId)
  }

  const HeaderToggle: ComponentType<{ readonly sessionId: string }> = ({ sessionId }) => {
    const t = workspaceMessages.useTranslate()
    const records = useSessionFiles(sessionId)
    const sessionPreview = state.usePreviewStore((current) =>
      state.getSessionPreview(current, sessionId)
    )
    const open = deps.panel.useLayout(() => deps.panel.isOpen(sessionId))
    const artifactKeys = useMemo(
      () => collectWorkspaceArtifacts(records).map((item) => item.key),
      [records]
    )
    const visible = artifactKeys.length > 0 || sessionPreview.uploadKeys.length > 0
    if (!visible) {
      return null
    }
    return createElement(IconButton, {
      size: 'm',
      tone: 'primary',
      className: open ? headerToggleStyles.active : undefined,
      icon: createElement(IconBrowseOutline16),
      tooltip: t(open ? 'previewClosePanel' : 'previewOpenPanel'),
      tooltipPlacement: 'bottom',
      'aria-pressed': open,
      onClick: () => state.togglePreviewPanel(sessionId, artifactKeys),
    })
  }

  const capability: ToolCapability = {
    id: 'workspace-files',
    declareTools: () => PREVIEW_TOOLS,
    instructions: (names, audience) =>
      audience === 'reply' && [...names].some((name) => PREVIEW_TOOL_NAMES.has(name))
        ? PREVIEW_TOOL_INSTRUCTIONS
        : null,
    describe: (name, audience) =>
      audience === 'reply' ? (PREVIEW_TOOLS.find((tool) => tool.name === name) ?? null) : null,
    handles: (name) => PREVIEW_TOOL_NAMES.has(name),
    effectOf: (name) => (name === READ_FILE_TOOL_NAME ? 'read' : 'artifact'),
    run: async (call, ctx) => {
      const outcome = await runPreviewTool(call.name, call.input, {
        records: getRecords(ctx.sessionId),
        replyId: ctx.replyId,
        loadFile,
        newId,
      })
      let text = outcome.text
      let delivered: DeliveredFileRef[] | undefined
      if (outcome.file) {
        let saved = true
        if (blobs) {
          try {
            await blobs.put([{ id: outcome.file.ref.id, blob: outcome.file.blob }])
          } catch {
            saved = false
            text +=
              '\n[Saving the file in the browser failed, so the user cannot preview or download it.]'
          }
        }
        if (saved) {
          delivered = [
            {
              id: outcome.file.ref.id,
              name: outcome.file.ref.name,
              size: outcome.file.ref.size,
              mimeType: outcome.file.ref.mimeType,
              ...(outcome.file.ref.path ? { path: outcome.file.ref.path } : {}),
              ...(outcome.file.ref.title ? { title: outcome.file.ref.title } : {}),
              ...(outcome.file.ref.version !== undefined
                ? { version: outcome.file.ref.version }
                : {}),
              producer: 'workspace-files',
            },
          ]
        }
      }
      return {
        content: text,
        status: outcome.status,
        durationMs: outcome.durationMs,
        payload: outcome.fileAction,
        ...(delivered ? { files: delivered } : {}),
      }
    },
    presenter: workspaceFilesPresenter,
    serializeForArchive: serializeWorkspaceFileForArchive,
    buildCompactionLedger: (
      entries: readonly ActivityStepEntry[]
    ): CompactionLedgerSection | null => {
      const saved = new Map<string, { path: string; title?: string; version?: number }>()
      const failed = new Map<string, { path: string; tool: string; reason: string }>()
      for (const { call, result } of entries) {
        if (!result || result.status === 'running' || call.name === READ_FILE_TOOL_NAME) {
          continue
        }
        const inputPath =
          call.input && typeof (call.input as { path?: unknown }).path === 'string'
            ? (call.input as { path: string }).path.trim()
            : ''
        if (result.status === 'ok' && result.files && result.files.length > 0) {
          for (const file of result.files) {
            const path = file.path ?? file.name
            const key = makeArtifactKey(path)
            saved.set(key, { path, title: file.title, version: file.version })
            failed.delete(key)
          }
        } else if (result.status === 'error' && inputPath) {
          const key = makeArtifactKey(inputPath)
          const firstLine = result.content.split('\n')[0]?.trim().slice(0, 160) || 'error'
          failed.set(key, { path: inputPath, tool: call.name, reason: firstLine })
        }
      }
      const lines: string[] = []
      for (const file of saved.values()) {
        const version = file.version !== undefined ? `v${file.version}` : 'saved'
        const meta = file.title ? `${version}, ${file.title}` : version
        lines.push(`- \`${file.path}\` (${meta})`)
      }
      for (const err of failed.values()) {
        lines.push(`- \`${err.path}\` (${err.tool} failed: ${err.reason})`)
      }
      if (saved.size > 0) {
        lines.push('Use `read_file` to inspect the full current content of any saved file.')
      }
      return lines.length > 0 ? { title: 'Workspace files', lines } : null
    },
  }

  return {
    toolNames: PREVIEW_TOOL_NAMES,
    instructions: PREVIEW_TOOL_INSTRUCTIONS,
    capability,
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
        loadFile,
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
    openDeliveredFile,
    openUploadFile,
    useIsDeliveredFileShown,
    useIsUploadFileShown,
    HeaderToggle,
    togglePanel: state.togglePreviewPanel,
    closePanel: state.closePreviewPanel,
    getSession: (sessionId: string): SessionPreviewState =>
      state.getSessionPreview(state.usePreviewStore.getState(), sessionId),
    /** React: a chat's preview state. */
    useSession: (sessionId: string | null): SessionPreviewState =>
      state.usePreviewStore((current) => state.getSessionPreview(current, sessionId)),
    /** React: whether the chat has any uploads or delivered files in its visible branch. */
    useHasFiles: (sessionId: string | null): boolean => useSessionFiles(sessionId).length > 0,
    /** Refreshes the still image shown while the native preview is hidden. */
    refreshSnapshot: state.triggerNativePreviewSnapshot,

    PreviewPanel: createPreviewPanel({
      state,
      panel: deps.panel,
      host: deps.host,
      views: deps.views,
      useSessionFiles,
      loadFile,
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
