import type { ToolCapability } from '@deepseek-chat/lib-tools'
import { IconBrowserOutline14 } from '@deepseek-chat/lib-ui'
import type { BrowserControlTakenOver } from '@deepseek-chat/spine/facts/browser'
import type {
  ActiveSessionChanged,
  ReplyLifecycleChanged,
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
import { createElement } from 'react'
import {
  browserPresenter,
  createBrowserHeaderToggle,
  createBrowserPanel,
  createLocalhostSetting,
  serializeBrowserForArchive,
} from '../cells/panel/index.js'
import { createBrowserController, createLocalhostPreference } from '../cells/runtime/index.js'
import { createBrowserTools } from '../cells/tools/index.js'
import {
  BROWSER_TOOL_INSTRUCTIONS,
  BROWSER_TOOL_NAMES,
  BROWSER_TOOLS,
  browserMessages,
  buildBrowserCompactionLedger,
  type BrowserHost,
  type BrowserToolDefinition,
  type BrowserToolRunResult,
  type SessionBrowserState,
} from '../kernel/index.js'

export type {
  BrowserBounds,
  BrowserHost,
  BrowserTab,
  BrowserTabStatePayload,
  BrowserToolDefinition,
  BrowserToolRunResult,
  SessionBrowserState,
} from '../kernel/index.js'
export { computeSomBadgeBoxes } from '../cells/tools/index.js'
export { isHttpUrl, normalizeOmniboxInput } from '../kernel/index.js'

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
  const controller = createBrowserController({
    host: deps.host,
    panel: deps.panel,
    allowLocalhost,
    openExternal: deps.openExternal,
    notify: {
      navigationBlocked: (url, reason) =>
        notice.show({
          text: browserMessages.lazy('browserNavigationBlocked', { url, reason }),
          tone: 'error',
        }),
      downloadBlocked: (reason) =>
        notice.show({
          text: browserMessages.lazy('browserDownloadBlocked', { reason }),
        }),
    },
    newId: deps.newId ?? (() => crypto.randomUUID()),
  })
  const tools = createBrowserTools(controller, deps.host)
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
    tools.hideCursor(sessionId)
    deps.log.publish<BrowserControlTakenOver>({
      type: 'BrowserControlTakenOver',
      sessionId,
    })
  }

  const unsubscribers = [
    deps.log.subscribe<ActiveSessionChanged>('ActiveSessionChanged', ({ fact }) => {
      controller.setActiveBrowserSession(fact.sessionId)
    }),
    deps.log.subscribe<SessionDeleted>('SessionDeleted', ({ fact }) => {
      void controller.disposeSessionBrowser(fact.sessionId)
    }),
    deps.log.subscribe<SessionHistoryReplaced>('SessionHistoryReplaced', () => {
      void controller.clearAllSessionBrowsers()
    }),
    // The agent cursor stays on screen for the whole reply that drives the browser, then goes.
    deps.log.subscribe<ReplyLifecycleChanged>('ReplyLifecycleChanged', ({ fact }) => {
      if (fact.phase === 'settled') {
        tools.hideCursor(fact.sessionId)
      }
    }),
  ]

  const HeaderToggle = createBrowserHeaderToggle(controller, {
    panel: deps.panel,
    desktop,
  })

  const capability: ToolCapability = {
    id: 'browser',
    ...(desktop
      ? {
          toggle: {
            id: 'browser',
            label: browserMessages.lazy('browserToggleLabel'),
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
      const outcome = await tools.runBrowserTool(call.name, call.input, ctx.signal, ctx.sessionId)
      return {
        content: outcome.text,
        status: outcome.status,
        durationMs: outcome.durationMs,
        ...(outcome.images.length > 0 ? { images: outcome.images } : {}),
        ...(outcome.previewImages?.length ? { previewImages: outcome.previewImages } : {}),
        payload: outcome.meta,
      }
    },
    presenter: browserPresenter,
    serializeForArchive: serializeBrowserForArchive,
    buildCompactionLedger: buildBrowserCompactionLedger,
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
    setActiveSession: controller.setActiveBrowserSession,
    /** Binds desktop host events; returns the unbinding function. */
    start: controller.bindBrowserEvents,
    getSession: (sessionId: string): SessionBrowserState => controller.getSession(sessionId),
    openPanel: controller.openBrowserPanel,
    closePanel: controller.closeBrowserPanel,
    togglePanel: controller.toggleBrowserPanel,
    /** Opens a URL in the panel (or externally on the new-chat screen). */
    openUrl: controller.openUrlInBrowserPanel,
    /** User takes over control of the browser for `sessionId` (publishes `BrowserControlTakenOver`). */
    takeOver,
    HeaderToggle,
    tabs: {
      create: controller.createBrowserTab,
      close: controller.closeBrowserTab,
      switch: controller.switchBrowserTab,
      navigate: controller.navigateBrowserTab,
      setViewport: controller.setBrowserTabViewport,
    },
    setStageSize: controller.setBrowserStageSize,
    setPanelBounds: controller.setBrowserPanelBounds,
    /** Refreshes the still image shown while the native webview is hidden. */
    refreshSnapshot: controller.refreshActiveTabSnapshot,

    BrowserPanel: createBrowserPanel(controller, {
      panel: deps.panel,
      desktop,
      openExternal: deps.openExternal,
    }),
    LocalhostSetting: createLocalhostSetting(allowLocalhost),
    dispose: () => {
      tools.dispose()
      toggleListeners.clear()
      for (const unsubscribe of unsubscribers) {
        unsubscribe()
      }
    },
  }
}

export type BrowserSlice = ReturnType<typeof createBrowserSlice>
