/**
 * Thin factory composition root for the Sealed Slice Architecture (Profile 1).
 *
 * Zero module-level slice instances, zero `lateBindings`, zero domain logic: every runtime
 * owns its own Spine `EventLog`, stores, capability registry, slices, and clean `dispose()`.
 */
import { createDeepSeekProvider, type ModelProvider } from '@deepseek-chat/lib-agent'
import {
  createToolRegistry,
  type CompositionPromptNote,
  type ToolCapability,
} from '@deepseek-chat/lib-tools'
import { copyText, createNoticeBus, createOverlayCoordinator } from '@deepseek-chat/lib-ui'
import { createAccountSlice, type AccountSlice } from '@deepseek-chat/slice-account'
import { createAskUserSlice, type AskUserSlice } from '@deepseek-chat/slice-ask-user'
import {
  createBrowserSlice,
  type BrowserHost,
  type BrowserSlice,
} from '@deepseek-chat/slice-browser'
import {
  createConversationsSlice,
  type ChatFile,
  type ConversationsSlice,
  type SessionStore,
  type SettingsSection,
  type StreamTrace,
} from '@deepseek-chat/slice-conversations'
import {
  createHistoryBackupSlice,
  type HistoryBackupSlice,
} from '@deepseek-chat/slice-history-backup'
import { createPreferencesSlice, type PreferencesSlice } from '@deepseek-chat/slice-preferences'
import {
  createPythonSlice,
  type NativePythonHost,
  type PythonSlice,
} from '@deepseek-chat/slice-python'
import { createSubagentsSlice, type SubagentsSlice } from '@deepseek-chat/slice-subagents'
import { createVoiceSlice, type VoiceSlice } from '@deepseek-chat/slice-voice'
import {
  createWebResearchSlice,
  type LocalScraper,
  type WebResearchSlice,
} from '@deepseek-chat/slice-web-research'
import {
  createWorkspaceFilesSlice,
  type PreviewHost,
  type WorkspaceFilesSlice,
} from '@deepseek-chat/slice-workspace-files'
import { createLocaleStore, type LocaleStore } from '@deepseek-chat/spine/i18n'
import type { BlobStore, HttpFetch, KeyValueStore, SecretSlot } from '@deepseek-chat/spine/ports'
import { EventLog } from '@deepseek-chat/spine/runtime'
import type { ComponentType } from 'react'
import { create } from 'zustand'
import { createSiderLayoutController, type SiderLayoutController } from './layout.js'
import { createRightPanelController, type RightPanelController } from './rightPanel/state.js'
import { createId } from './utils/id.js'
import { workspaceViews } from './workspaceViews.js'

const PYODIDE_VERSION = '314.0.8'

export type EnabledSlices = {
  readonly preferences?: boolean
  readonly voice?: boolean
  readonly webResearch?: boolean
  readonly python?: boolean
  readonly workspaceFiles?: boolean
  readonly browser?: boolean
  readonly askUser?: boolean
  readonly subagents?: boolean
  readonly historyBackup?: boolean
}

export type DesktopHostAdapters = {
  readonly browserHost?: BrowserHost | null
  readonly previewHost?: PreviewHost | null
  readonly pythonNative?: NativePythonHost | null
  readonly localScrape?: LocalScraper | null
  readonly accountSecret?: SecretSlot | null
  readonly firecrawlSecret?: SecretSlot | null
  readonly openExternal?: (url: string) => Promise<void>
  readonly onOpenSettings?: (handler: () => void) => () => void
}

export type AppRuntimeConfig = {
  readonly store: KeyValueStore
  readonly blobs: BlobStore & { close?: () => void }
  readonly sessions: SessionStore
  readonly fetch?: HttpFetch
  readonly apiOrigin?: string
  /** Optional model provider override (defaults to DeepSeek Messages API over `fetch`/`apiOrigin`). */
  readonly provider?: ModelProvider
  readonly platform?: 'desktop' | 'web'
  readonly locale?: LocaleStore
  readonly browserLanguage?: string
  readonly pyodideIndexURL?: string
  readonly enabledSlices?: EnabledSlices
  readonly extraCapabilities?: readonly ToolCapability[]
  readonly desktop?: DesktopHostAdapters
  readonly saveFile?: (name: string, blob: Blob) => Promise<void>
  readonly copyText?: (text: string) => Promise<boolean>
  readonly onStreamTrace?: (trace: StreamTrace) => void
  readonly autoTitle?: boolean
  readonly syncDocumentTheme?: boolean
}

/**
 * Static cross-capability prompt guidance emitted only when all required capabilities are active
 * in the same turn. Keeps standalone slice instructions free of sibling references while staying
 * static for KV-cache reuse.
 */
export const COMPOSITION_PROMPT_NOTES: readonly CompositionPromptNote[] = [
  {
    requires: ['web-research', 'browser'],
    audience: 'reply',
    text: 'Choosing between Web Research and the Built-in Browser: reach for `web_search` and `web_scrape` first when you only need current facts, articles, docs, or clean Markdown from public URLs. Switch to the Built-in Browser when you need interactive page manipulation (clicking, typing, signing in, bypassing client-side loading states) or visual inspection of a live site.',
  },
  {
    requires: ['web-research', 'workspace-files'],
    audience: 'reply',
    text: 'Citations in delivered files: `[ref:N]` citation badges render only inside chat replies. Inside files created with `present_file` or `edit_file`, write standalone Markdown links like `[Source Name](https://...)` rather than `[ref:N]` so the exported document stands on its own.',
  },
  {
    requires: ['python', 'workspace-files'],
    audience: 'reply',
    text: 'Python and Workspace Files: user attachments and the latest version of files created with `present_file` or `edit_file` are mounted read-only under `uploads/` in the Python sandbox. Files saved through `show()` in Python are delivered into the chat and open in the File Preview panel automatically.',
  },
  {
    requires: ['browser', 'workspace-files'],
    audience: 'reply',
    text: 'Local deliverables vs Built-in Browser: never point `browser_navigate` at `file://` or `data:` URLs to preview HTML, Markdown, SVG, or charts you generated. Deliver local documents with `present_file` and update them with `edit_file` so they open in the dedicated File Preview panel.',
  },
]

const defaultPyodideUrl = () => {
  if (
    typeof __PYODIDE_LOCAL__ === 'boolean' &&
    __PYODIDE_LOCAL__ &&
    typeof document !== 'undefined'
  ) {
    return new URL('pyodide/', document.baseURI).href
  }
  return `https://cdn.jsdelivr.net/pyodide/v${PYODIDE_VERSION}/full/`
}

const defaultApiOrigin = () =>
  typeof __API_ORIGIN__ === 'string' ? __API_ORIGIN__ : 'https://api.deepseek.com'

export const createAppRuntime = (config: AppRuntimeConfig) => {
  const enabled: Required<EnabledSlices> = {
    preferences: config.enabledSlices?.preferences ?? true,
    voice: config.enabledSlices?.voice ?? true,
    webResearch: config.enabledSlices?.webResearch ?? true,
    python: config.enabledSlices?.python ?? true,
    workspaceFiles: config.enabledSlices?.workspaceFiles ?? true,
    browser: config.enabledSlices?.browser ?? true,
    askUser: config.enabledSlices?.askUser ?? true,
    subagents: config.enabledSlices?.subagents ?? true,
    historyBackup: config.enabledSlices?.historyBackup ?? true,
  }

  const { store, blobs, sessions } = config
  const httpFetch: HttpFetch = config.fetch ?? ((url, init) => globalThis.fetch(url, init))
  const apiOrigin = config.apiOrigin ?? defaultApiOrigin()
  const platform = config.platform ?? 'web'
  const desktop = config.desktop ?? {}
  const saveFile = config.saveFile ?? (async () => {})
  const copy = config.copyText ?? copyText
  const openExternal =
    desktop.openExternal ??
    (async (url: string) => {
      if (typeof window !== 'undefined') {
        window.open(url, '_blank', 'noopener,noreferrer')
      }
    })

  // ---------- Spine + app-shell controllers ----------
  const log = new EventLog()
  const locale: LocaleStore = config.locale ?? createLocaleStore()
  const notices = createNoticeBus()
  const overlays = createOverlayCoordinator()
  const rightPanel: RightPanelController = createRightPanelController(store, log)

  const useSettingsDialog = create<{ open: boolean; section: SettingsSection }>(() => ({
    open: false,
    section: 'general',
  }))
  const openSettings = (section: SettingsSection = 'general') =>
    useSettingsDialog.setState({ open: true, section })
  const closeSettings = () => useSettingsDialog.setState({ open: false })
  const openSettingsFromShortcut = () => {
    if (!useSettingsDialog.getState().open) {
      openSettings('general')
    }
  }

  let releaseUiOverlay: (() => void) | null = null
  const unsubOverlays = overlays.subscribe((open) => {
    if (open) {
      if (!releaseUiOverlay) {
        releaseUiOverlay = rightPanel.acquireOverlayLock()
      }
    } else {
      releaseUiOverlay?.()
      releaseUiOverlay = null
    }
  })

  // ---------- Core + optional slices ----------
  const preferences: PreferencesSlice | null = enabled.preferences
    ? createPreferencesSlice({
        store,
        locale,
        browserLanguage:
          config.browserLanguage ??
          (typeof navigator === 'undefined' ? 'en-US' : navigator.language),
      })
    : null

  const account: AccountSlice = createAccountSlice({
    store,
    secret: desktop.accountSecret ?? null,
    fetch: httpFetch,
    apiOrigin,
  })

  const provider: ModelProvider =
    config.provider ??
    createDeepSeekProvider({
      fetch: httpFetch,
      apiOrigin,
      getApiKey: () => account.getApiKey(),
    })

  const voice: VoiceSlice | null = enabled.voice
    ? createVoiceSlice({
        log,
        fetch: httpFetch,
        apiOrigin,
        apiKey: () => account.getApiKey(),
        store,
        notify: notices,
      })
    : null

  const webResearch: WebResearchSlice | null = enabled.webResearch
    ? createWebResearchSlice({
        fetch: httpFetch,
        store,
        secret: desktop.firecrawlSecret ?? null,
        localScrape: desktop.localScrape ?? null,
      })
    : null

  const python: PythonSlice | null = enabled.python
    ? createPythonSlice({
        log,
        native: desktop.pythonNative ?? null,
        pyodideIndexURL: config.pyodideIndexURL ?? defaultPyodideUrl(),
        store,
        blobs,
        newId: createId,
      })
    : null

  const workspaceFiles: WorkspaceFilesSlice | null = enabled.workspaceFiles
    ? createWorkspaceFilesSlice({
        log,
        panel: rightPanel.createSlot('preview'),
        host: desktop.previewHost ?? null,
        blobs,
        saveFile,
        copyText: copy,
        views: workspaceViews,
        notify: notices,
        newId: createId,
      })
    : null

  const browser: BrowserSlice | null = enabled.browser
    ? createBrowserSlice({
        log,
        host: desktop.browserHost ?? null,
        panel: rightPanel.createSlot('browser'),
        store,
        openExternal,
        notify: notices,
        newId: createId,
      })
    : null

  const askUser: AskUserSlice | null = enabled.askUser ? createAskUserSlice({ log }) : null

  // Non-subagent capabilities form the eager read-only host for child agents (non-recursive by construction).
  const baseCapabilities: ToolCapability[] = [
    ...(workspaceFiles ? [workspaceFiles.capability] : []),
    ...(askUser ? [askUser.capability] : []),
    ...(webResearch ? [webResearch.capability] : []),
    ...(python ? [python.capability] : []),
    ...(browser ? [browser.capability] : []),
    ...(config.extraCapabilities ?? []),
  ]
  const childToolHost = createToolRegistry(baseCapabilities, COMPOSITION_PROMPT_NOTES)
  const subagents: SubagentsSlice | null = enabled.subagents
    ? createSubagentsSlice({
        log,
        provider,
        toolHost: childToolHost,
        newId: createId,
      })
    : null
  const toolRegistry = subagents
    ? createToolRegistry([...baseCapabilities, subagents.capability], COMPOSITION_PROMPT_NOTES)
    : childToolHost

  const headerActions: ComponentType<{ readonly sessionId: string }>[] = [
    ...(workspaceFiles ? [workspaceFiles.HeaderToggle] : []),
    ...(browser ? [browser.HeaderToggle] : []),
  ]

  const conversations: ConversationsSlice = createConversationsSlice({
    log,
    locale,
    provider,
    store,
    blobs,
    sessions,
    tools: toolRegistry,
    activityPanel: rightPanel.createSlot('activity'),
    platform,
    getLocationLabel: (locale) => preferences?.getLocationLabel(locale) ?? '',
    onStreamTrace: config.onStreamTrace,
    autoTitle: config.autoTitle,
    notify: notices,
    newId: createId,
    ui: {
      voice: voice
        ? {
            useVoiceInput: voice.useVoiceInput,
            VoiceButton: voice.VoiceButton,
            Spectrum: voice.Spectrum,
            ReadAloudButton: voice.ReadAloudButton,
          }
        : null,
      headerActions,
      composerDock: askUser?.ComposerDock,
      useHasComposerDock: askUser?.useHasPending,
      openFile: workspaceFiles
        ? (sessionId: string, file: ChatFile) => {
            if (file.kind === 'delivered') {
              workspaceFiles.openDeliveredFile(sessionId, file.file)
            } else {
              workspaceFiles.openUploadFile(sessionId, file.fileId)
            }
          }
        : undefined,
      useIsFileShown: workspaceFiles
        ? (sessionId: string, file: ChatFile) =>
            file.kind === 'delivered'
              ? workspaceFiles.useIsDeliveredFileShown(sessionId, file.file)
              : workspaceFiles.useIsUploadFileShown(sessionId, file.fileId)
        : undefined,
      useNeedsApiKey: () => {
        if (config.provider) {
          return !config.provider.isConfigured()
        }
        const state = account.useState()
        return state.status === 'ready' && !state.apiKey
      },
      openSettings,
      openInApp: browser?.available
        ? (url: string) => {
            void browser.openUrl(url, { initiator: 'user' })
          }
        : null,
      saveFile,
    },
  })

  const layout: SiderLayoutController = createSiderLayoutController(log, conversations)

  const historyBackup: HistoryBackupSlice | null = enabled.historyBackup
    ? createHistoryBackupSlice({
        blobs,
        sessions: {
          snapshotForExport: conversations.snapshotForExport,
          replaceHistory: conversations.replaceSessions,
          useState: conversations.useHistoryState,
          describeReplyNotice: conversations.describeReplyNotice,
        },
        serializeToolBlock: toolRegistry.serializeForArchive,
        notify: notices,
        saveFile,
      })
    : null

  const hydrate = async (): Promise<void> => {
    await Promise.all([
      account.hydrate(),
      webResearch?.hydrate() ?? Promise.resolve(),
      conversations.commands.init(),
    ])
  }

  let disposed = false
  const dispose = () => {
    if (disposed) {
      return
    }
    disposed = true
    unsubOverlays()
    releaseUiOverlay?.()
    releaseUiOverlay = null
    layout.dispose()
    historyBackup?.dispose()
    conversations.dispose()
    subagents?.dispose()
    askUser?.dispose()
    browser?.dispose()
    workspaceFiles?.dispose()
    python?.dispose()
    webResearch?.dispose()
    voice?.dispose()
    account.dispose()
    preferences?.dispose()
    rightPanel.dispose()
  }

  return {
    platform,
    enabled,
    syncDocumentTheme: config.syncDocumentTheme ?? false,
    onOpenSettingsShortcut: desktop.onOpenSettings ?? null,
    log,
    locale,
    notices,
    overlays,
    blobs,
    provider,
    tools: toolRegistry,
    rightPanel,
    layout: {
      useStore: layout.useStore,
      getState: layout.getState,
      setSiderCollapsed: layout.setSiderCollapsed,
    },
    settingsDialog: {
      useStore: useSettingsDialog,
      open: openSettings,
      close: closeSettings,
      openFromShortcut: openSettingsFromShortcut,
      ensureApiKey: () => {
        if (provider.isConfigured()) {
          return true
        }
        openSettings('apiKey')
        return false
      },
    },
    slices: {
      preferences,
      account,
      voice,
      webResearch,
      python,
      workspaceFiles,
      browser,
      askUser,
      subagents,
      conversations,
      historyBackup,
    },
    hydrate,
    dispose,
  }
}

export type AppRuntime = ReturnType<typeof createAppRuntime>
