import type { ToolCapability } from '@deepseek-chat/lib-tools'
import { IconBrowserOutline14, IconButton, IconGlobeLanguageOutline16 } from '@deepseek-chat/lib-ui'
import type { BrowserControlTakenOver } from '@deepseek-chat/spine/facts/browser'
import type {
  ActiveSessionChanged,
  SessionDeleted,
  SessionHistoryReplaced,
} from '@deepseek-chat/spine/facts/session'
import {
  noopNoticePort,
  type KeyValueStore,
  type NoticePort,
  type PanelSlot,
} from '@deepseek-chat/spine/ports'
import type { EventLog } from '@deepseek-chat/spine/runtime'
import { createElement, type ComponentType } from 'react'
import { createBrowserPanel } from './BrowserPanel.js'
import headerToggleStyles from './HeaderToggle.module.css'
import type { BrowserHost } from './host.js'
import { createLocalhostSetting } from './LocalhostSetting.js'
import { browserMessages } from './messages.js'
import { createLocalhostPreference } from './prefs.js'
import { browserPresenter, serializeBrowserForArchive } from './presenter.js'
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
export type { SomBadgeBox, SomBadgeElement, SomBadgeLayout } from './somOverlay.js'
export type { BrowserTab, SessionBrowserState } from './state.js'
export type { BrowserActionMeta, BrowserToolDefinition, BrowserToolRunResult } from './tools.js'
export { computeSomBadgeBoxes } from './somOverlay.js'
export { isHttpUrl, normalizeOmniboxInput } from './state.js'
/** Tool names persisted in chat history; never rename. */
export { BROWSER_TOOL_NAMES } from './tools.js'

const BROWSER_TOGGLE_KEY = 'chat-demo:browser'

export type BrowserSliceDeps = {
  readonly log: EventLog
  /** Desktop host; `null` on the web, where the browser is unavailable. */
  readonly host: BrowserHost | null
  /** This slice's slot in the app's right-hand panel. */
  readonly panel: PanelSlot
  /** Persists the localhost-access choice and `chat-demo:browser` toggle. */
  readonly store: KeyValueStore
  /** Opens a URL outside the app (system browser). */
  readonly openExternal: (url: string) => Promise<void>
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

  let enabled = deps.store.get(BROWSER_TOGGLE_KEY) === 'true'
  const toggleListeners = new Set<() => void>()
  const setEnabled = (next: boolean) => {
    if (enabled === next) {
      return
    }
    enabled = next
    deps.store.set(BROWSER_TOGGLE_KEY, String(next))
    for (const listener of [...toggleListeners]) {
      listener()
    }
  }

  const takeOver = (sessionId: string) => {
    state.clearBrowserControlling(sessionId)
    deps.log.publish<BrowserControlTakenOver>({
      type: 'BrowserControlTakenOver',
      sessionId,
    })
  }

  const unsubscribers = [
    deps.log.subscribe<ActiveSessionChanged>('ActiveSessionChanged', ({ fact }) => {
      state.setActiveBrowserSession(fact.sessionId)
    }),
    deps.log.subscribe<SessionDeleted>('SessionDeleted', ({ fact }) => {
      void state.disposeSessionBrowser(fact.sessionId)
    }),
    deps.log.subscribe<SessionHistoryReplaced>('SessionHistoryReplaced', () => {
      void state.clearAllSessionBrowsers()
    }),
  ]

  const HeaderToggle: ComponentType<{ readonly sessionId: string }> = ({ sessionId }) => {
    const t = browserMessages.useTranslate()
    const open = deps.panel.useLayout(() => deps.panel.isOpen(sessionId))
    if (!desktop) {
      return null
    }
    return createElement(IconButton, {
      size: 'm',
      tone: 'primary',
      className: open ? headerToggleStyles.active : undefined,
      icon: createElement(IconGlobeLanguageOutline16),
      tooltip: t(open ? 'closeBrowser' : 'openBrowser'),
      tooltipPlacement: 'bottom',
      'aria-pressed': open,
      onClick: () => void state.toggleBrowserPanel(sessionId),
    })
  }

  const capability: ToolCapability = {
    id: 'browser',
    ...(desktop
      ? {
          toggle: {
            id: 'browser',
            label: () => browserMessages.translate('browserToggleLabel'),
            icon: createElement(IconBrowserOutline14),
            isEnabled: () => enabled,
            setEnabled,
            subscribe: (listener) => {
              toggleListeners.add(listener)
              return () => {
                toggleListeners.delete(listener)
              }
            },
          },
        }
      : {}),
    declareTools: ({ enabledCapabilities }) =>
      desktop && enabledCapabilities.browser ? BROWSER_TOOLS : [],
    instructions: (names, audience) =>
      audience === 'reply' && [...names].some((name) => BROWSER_TOOL_NAMES.has(name))
        ? BROWSER_TOOL_INSTRUCTIONS
        : null,
    describe: (name, audience) =>
      audience === 'reply' && desktop
        ? (BROWSER_TOOLS.find((tool) => tool.name === name) ?? null)
        : null,
    handles: (name) => BROWSER_TOOL_NAMES.has(name),
    effectOf: () => 'session',
    run: async (call, ctx) => {
      const outcome = await tools.runBrowserTool(call.name, call.input, ctx.signal, ctx.sessionId, {
        holdControl: ctx.caller.kind === 'reply',
      })
      return {
        content: outcome.text,
        status: outcome.status,
        durationMs: outcome.durationMs,
        ...(outcome.images.length > 0 ? { images: outcome.images } : {}),
        ...(outcome.previewImages?.length ? { previewImages: outcome.previewImages } : {}),
        payload: outcome.meta,
      }
    },
    turnHooks: {
      onTurnSettled: ({ sessionId }) => {
        state.clearBrowserControlling(sessionId)
      },
    },
    presenter: browserPresenter,
    serializeForArchive: serializeBrowserForArchive,
  }

  return {
    /** Whether the built-in browser exists here (desktop only). */
    available: desktop,
    toolNames: BROWSER_TOOL_NAMES,
    instructions: BROWSER_TOOL_INSTRUCTIONS,
    capability,
    /** Tools to declare for a turn: all browser tools when enabled on desktop, else none. */
    declareTools: ({ enabled: isOn }: { enabled: boolean }): BrowserToolDefinition[] =>
      isOn && desktop ? BROWSER_TOOLS : [],
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
    /** User takes over control of the browser for `sessionId` (publishes `BrowserControlTakenOver`). */
    takeOver,
    HeaderToggle,
    tabs: {
      create: state.createBrowserTab,
      close: state.closeBrowserTab,
      switch: state.switchBrowserTab,
      navigate: state.navigateBrowserTab,
      setViewport: state.setBrowserTabViewport,
    },
    setStageSize: state.setBrowserStageSize,
    setPanelBounds: state.setBrowserPanelBounds,
    /** Refreshes the still image shown while the native webview is hidden. */
    refreshSnapshot: state.refreshActiveTabSnapshot,

    BrowserPanel: createBrowserPanel(state, {
      panel: deps.panel,
      desktop,
      openExternal: deps.openExternal,
      takeOver,
    }),
    LocalhostSetting: createLocalhostSetting(allowLocalhost),
    dispose: () => {
      toggleListeners.clear()
      for (const unsubscribe of unsubscribers) {
        unsubscribe()
      }
    },
  }
}

export type BrowserSlice = ReturnType<typeof createBrowserSlice>
