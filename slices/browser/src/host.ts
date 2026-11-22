/** Native child-webview bounds in window CSS pixels. */
export type BrowserBounds = {
  x: number
  y: number
  width: number
  height: number
}

export type BrowserTabStatePayload = {
  tabId: string
  url: string
  title: string | null
  isLoading: boolean | null
  canGoBack: boolean | null
  canGoForward: boolean | null
}

export type BrowserNewTabPayload = { tabId: string; url: string }

export type BrowserBlockedPayload = { tabId: string; url: string; reason: string }

export type BrowserSnapshotResult = { dataUrl: string; width: number; height: number }

export type BrowserStateResult = { url: string; canGoBack: boolean; canGoForward: boolean }

/**
 * The desktop host's native multi-webview browser. One native webview per tab is drawn above the
 * page at `bounds`; only the active tab is visible. The web build has no host (`null`).
 */
export type BrowserHost = {
  setOptions(allowLocalhost: boolean): Promise<void>
  createTab(options: {
    tabId: string
    url: string
    bounds: BrowserBounds
    visible: boolean
    zoom?: number
  }): Promise<void>
  closeTab(tabId: string): Promise<void>
  setActiveTab(tabId: string | null, bounds: BrowserBounds | null, visible: boolean): Promise<void>
  setBounds(bounds: BrowserBounds, zoom?: number): Promise<void>
  setZoom(tabId: string, zoom: number): Promise<number>
  setVisible(visible: boolean): Promise<void>
  /** Resolves with the final URL. */
  navigate(tabId: string, url: string, initiator: 'user' | 'model'): Promise<string>
  history(tabId: string, action: 'back' | 'forward' | 'reload' | 'stop'): Promise<void>
  getState(tabId: string): Promise<BrowserStateResult>
  /** Runs `script` in the page; resolves with its string result. */
  evalJs(tabId: string, script: string, isolatedWorld: boolean, timeoutMs?: number): Promise<string>
  takeSnapshot(tabId: string, maxWidth?: number): Promise<BrowserSnapshotResult>
  clearData(tabId: string): Promise<void>
  openDevtools(tabId: string): Promise<void>
  onState(handler: (payload: BrowserTabStatePayload) => void): () => void
  onNewTabRequested(handler: (payload: BrowserNewTabPayload) => void): () => void
  onNavigationBlocked(handler: (payload: BrowserBlockedPayload) => void): () => void
  onDownloadBlocked(handler: (payload: BrowserBlockedPayload) => void): () => void
}

const unavailable = () =>
  Promise.reject(new Error('Built-in browser is only available in the desktop app.'))

/** Stand-in used when there is no host; every call is guarded by `desktop` before it is reached. */
export const NO_HOST: BrowserHost = {
  setOptions: unavailable,
  createTab: unavailable,
  closeTab: unavailable,
  setActiveTab: unavailable,
  setBounds: unavailable,
  setZoom: unavailable,
  setVisible: unavailable,
  navigate: unavailable,
  history: unavailable,
  getState: unavailable,
  evalJs: unavailable,
  takeSnapshot: unavailable,
  clearData: unavailable,
  openDevtools: unavailable,
  onState: () => () => {},
  onNewTabRequested: () => () => {},
  onNavigationBlocked: () => () => {},
  onDownloadBlocked: () => () => {},
}
