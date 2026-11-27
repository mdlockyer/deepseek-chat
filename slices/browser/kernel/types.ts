import type { StageFit, ViewportSpec } from '@deepseek-chat/lib-stage'
import type { BrowserBounds } from './host.js'

export const MAX_LIVE_NATIVE_TABS = 14

export const DEFAULT_BROWSER_BOUNDS: BrowserBounds = {
  x: 640,
  y: 96,
  width: 540,
  height: 700,
}

export type BrowserTab = {
  id: string
  url: string
  title: string
  isLoading: boolean
  canGoBack: boolean
  canGoForward: boolean
  viewport: ViewportSpec | null
  zoom: number
  snapshotUrl: string | null
  snapshotWidth: number | null
  snapshotHeight: number | null
  error: string | null
}

/** Per-session browser tabs owned by the browser kernel; panel openness lives exclusively in `PanelSlot`. */
export type SessionBrowserTabs = {
  readonly tabs: readonly BrowserTab[]
  readonly activeTabId: string | null
}

export const EMPTY_SESSION_BROWSER_TABS: SessionBrowserTabs = {
  tabs: [],
  activeTabId: null,
}

/** Public session view projected from kernel tabs + live `PanelSlot.isOpen(sessionId)`. */
export type SessionBrowserState = {
  panelOpen: boolean
  tabs: BrowserTab[]
  activeTabId: string | null
}

export const EMPTY_SESSION_BROWSER_STATE: SessionBrowserState = {
  panelOpen: false,
  tabs: [],
  activeTabId: null,
}

export type BrowserControlState =
  | { readonly kind: 'idle' }
  | { readonly kind: 'controlling'; readonly sessionId: string; readonly action: string | null }

export type BrowserKernelState = {
  readonly activeSessionId: string | null
  readonly sessions: Readonly<Record<string, SessionBrowserTabs>>
  readonly control: BrowserControlState
  readonly bounds: BrowserBounds | null
  readonly stageSize: { readonly width: number; readonly height: number } | null
  /** What the agent cursor is typing into a tab's address bar, shown there until it navigates. */
  readonly agentAddress: { readonly tabId: string; readonly text: string } | null
}

export type LocalhostPreference = {
  get(): boolean
  set(next: boolean): void
  subscribe(listener: () => void): () => void
}

export type NavigationWatch = {
  readonly tabId: string
  readonly startUrl: string
  readonly startCompletedSeq: number
}

export type WaitForNavigationOptions = {
  readonly expectsNavigation: boolean
  readonly settleMs: number
  readonly startWindowMs?: number
  readonly loadTimeoutMs?: number
  readonly signal: AbortSignal
}

/** Narrow controller surface shared between runtime, tool-execution, and panel cells. */
export type BrowserController = {
  getState(): BrowserKernelState
  useState<T>(selector: (state: BrowserKernelState) => T): T
  getSession(sessionId: string): SessionBrowserState
  syncNativeVisibility(options?: { forceBounds?: boolean }): Promise<void>
  bindBrowserEvents(): () => void
  setActiveBrowserSession(sessionId: string | null): void
  disposeSessionBrowser(sessionId: string): Promise<void>
  clearAllSessionBrowsers(): Promise<void>
  ensureNativeTab(tabId: string, initiator?: 'user' | 'model'): Promise<void>
  createBrowserTab(
    url?: string,
    options?: { sessionId?: string; activate?: boolean; initiator?: 'user' | 'model' }
  ): Promise<BrowserTab>
  closeBrowserTab(tabId: string): Promise<void>
  switchBrowserTab(tabId: string): Promise<void>
  openBrowserPanel(sessionId?: string): Promise<boolean>
  revealBrowserPanel(sessionId?: string): Promise<boolean>
  closeBrowserPanel(sessionId?: string): Promise<void>
  toggleBrowserPanel(sessionId?: string): Promise<void>
  setBrowserStageSize(size: { width: number; height: number }): void
  setBrowserPanelBounds(bounds: BrowserBounds, zoom?: number, options?: { force?: boolean }): void
  setBrowserTabViewport(
    tabId: string,
    viewport: ViewportSpec | null,
    options?: { preserveSnapshot?: boolean }
  ): Promise<StageFit>
  refreshActiveTabSnapshot(): Promise<void>
  navigateBrowserTab(tabId: string, rawUrl: string, initiator?: 'user' | 'model'): Promise<string>
  openUrlInBrowserPanel(
    url: string,
    options?: { sessionId?: string; newTab?: boolean; initiator?: 'user' | 'model' }
  ): Promise<BrowserTab | null>
  runBrowserHistory(tabId: string, action: 'back' | 'forward' | 'reload' | 'stop'): Promise<void>
  clearBrowserTabData(tabId: string): Promise<void>
  openBrowserTabDevtools(tabId: string): Promise<void>
  beginNavigationWatch(tabId: string): NavigationWatch
  waitForNavigation(
    watch: NavigationWatch,
    options: WaitForNavigationOptions
  ): Promise<{ readonly navigated: boolean }>
  waitForTabLoad(tabId: string, signal: AbortSignal, timeoutMs?: number): Promise<void>
  setBrowserControlling(
    controlling: boolean,
    action?: string | null,
    sessionId?: string | null
  ): void
  getActiveBrowserTab(sessionId?: string | null): BrowserTab | null
  isTabOnScreen(tabId: string): boolean
  setAgentAddress(tabId: string, text: string | null): void
}
