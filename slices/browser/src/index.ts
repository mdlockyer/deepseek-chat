import type { SessionDeleted, SessionHistoryReplaced } from '@deepseek-chat/spine/facts/session'
import {
  noopNoticePort,
  type KeyValueStore,
  type NoticePort,
  type PanelSlot,
} from '@deepseek-chat/spine/ports'
import type { EventLog } from '@deepseek-chat/spine/runtime'
import { createBrowserPanel } from './BrowserPanel.js'
import type { BrowserHost } from './host.js'
import { createLocalhostSetting } from './LocalhostSetting.js'
import { browserMessages } from './messages.js'
import { createLocalhostPreference } from './prefs.js'
import { createBrowserState, getSessionBrowser, type SessionBrowserState } from './state.js'
import {
  BROWSER_TOOL_INSTRUCTIONS,
  BROWSER_TOOL_NAMES,
  BROWSER_TOOLS,
  createBrowserTools,
  type BrowserToolDefinition,
  type BrowserToolRunResult,
} from './tools.js'

export type * from './host.js'
export type { BrowserTab, SessionBrowserState } from './state.js'
export type { BrowserActionMeta, BrowserToolDefinition, BrowserToolRunResult } from './tools.js'
export { isHttpUrl, normalizeOmniboxInput } from './state.js'
/** Tool names persisted in chat history; never rename. */
export { BROWSER_TOOL_NAMES } from './tools.js'

export type BrowserSliceDeps = {
  readonly log: EventLog
  /** Desktop host; `null` on the web, where the browser is unavailable. */
  readonly host: BrowserHost | null
  /** This slice's slot in the app's right-hand panel. */
  readonly panel: PanelSlot
  /** Persists the localhost-access choice. */
  readonly store: KeyValueStore
  /** Opens a URL outside the app (system browser). */
  readonly openExternal: (url: string) => Promise<void>
  /** Stops the reply that is driving the browser in a session (the "take over" button). */
  readonly stopController: (sessionId: string) => void
  /** Ephemeral user feedback port; defaults to a safe no-op for headless callers. */
  readonly notify?: NoticePort
  readonly newId?: () => string
}

export const createBrowserSlice = (deps: BrowserSliceDeps) => {
  const allowLocalhost = createLocalhostPreference(deps.store)
  const notice = deps.notify ?? noopNoticePort
  const state = createBrowserState({
    host: deps.host,
    panel: deps.panel,
    allowLocalhost,
    openExternal: deps.openExternal,
    notify: {
      navigationBlocked: (url, reason) =>
        notice.show({
          text: () => browserMessages.translate('browserNavigationBlocked', { url, reason }),
          tone: 'error',
        }),
      downloadBlocked: (reason) =>
        notice.show({
          text: () => browserMessages.translate('browserDownloadBlocked', { reason }),
        }),
    },
    newId: deps.newId ?? (() => crypto.randomUUID()),
  })
  const tools = createBrowserTools(state, deps.host)
  const desktop = deps.host !== null

  const unsubscribers = [
    deps.log.subscribe<SessionDeleted>('SessionDeleted', ({ fact }) => {
      void state.disposeSessionBrowser(fact.sessionId)
    }),
    deps.log.subscribe<SessionHistoryReplaced>('SessionHistoryReplaced', () => {
      void state.clearAllSessionBrowsers()
    }),
  ]

  return {
    /** Whether the built-in browser exists here (desktop only). */
    available: desktop,
    toolNames: BROWSER_TOOL_NAMES,
    instructions: BROWSER_TOOL_INSTRUCTIONS,
    /** Tools to declare for a turn: all browser tools when enabled on desktop, else none. */
    declareTools: ({ enabled }: { enabled: boolean }): BrowserToolDefinition[] =>
      enabled && desktop ? BROWSER_TOOLS : [],
    handles: (toolName: string) => BROWSER_TOOL_NAMES.has(toolName),
    /** Runs one tool call; always resolves. Calls run one at a time. */
    run: (
      toolName: string,
      input: unknown,
      options: { signal: AbortSignal; sessionId?: string }
    ): Promise<BrowserToolRunResult> =>
      tools.runBrowserTool(toolName, input, options.signal, options.sessionId),

    /** The session whose chat is on screen (`null`: the new-chat screen). */
    setActiveSession: state.setActiveBrowserSession,
    /** Binds desktop host events; returns the unbinding function. */
    start: state.bindBrowserEvents,
    getSession: (sessionId: string): SessionBrowserState =>
      getSessionBrowser(state.useBrowserStore.getState(), sessionId),
    openPanel: state.openBrowserPanel,
    closePanel: state.closeBrowserPanel,
    togglePanel: state.toggleBrowserPanel,
    /** Opens a URL in the panel (or externally on the new-chat screen). */
    openUrl: state.openUrlInBrowserPanel,
    tabs: {
      create: state.createBrowserTab,
      close: state.closeBrowserTab,
      switch: state.switchBrowserTab,
      navigate: state.navigateBrowserTab,
      setViewport: state.setBrowserTabViewport,
    },
    setStageSize: state.setBrowserStageSize,
    setPanelBounds: state.setBrowserPanelBounds,
    /** Hides the native webview under an HTML overlay; returns the release function. */
    acquireOverlayLock: state.acquireBrowserOverlayLock,
    /** Refreshes the still image shown while the native webview is hidden. */
    refreshSnapshot: state.refreshActiveTabSnapshot,

    BrowserPanel: createBrowserPanel(state, {
      panel: deps.panel,
      desktop,
      openExternal: deps.openExternal,
      stopController: deps.stopController,
    }),
    LocalhostSetting: createLocalhostSetting(allowLocalhost),
    dispose: () => {
      for (const unsubscribe of unsubscribers) {
        unsubscribe()
      }
    },
  }
}

export type BrowserSlice = ReturnType<typeof createBrowserSlice>
