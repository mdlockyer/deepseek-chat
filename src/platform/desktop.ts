/**
 * 桌面版（Tauri）专用能力。网页版不会加载这里的 Tauri 依赖：所有调用都先判断 isDesktopApp，
 * 并通过动态 import 引入 @tauri-apps/api。
 */

/** 运行在 Tauri 桌面应用的 webview 里 */
export const isDesktopApp = typeof window !== 'undefined' && '__TAURI_INTERNALS__' in window

const invoke = async <T>(...args: Parameters<typeof import('@tauri-apps/api/core').invoke>) =>
  (await import('@tauri-apps/api/core')).invoke<T>(...args)

/**
 * 桌面版的网络请求由 Rust 端（tauri-plugin-http）发出：不受 webview 的 CORS 限制，
 * 也不复用 WKWebView 的连接（Safari 会在复用刚被服务端关闭的连接时报 network connection lost）。
 * 支持流式响应体与 AbortSignal。
 */
export const desktopFetch = async (url: string, init: RequestInit): Promise<Response> =>
  (await import('@tauri-apps/plugin-http')).fetch(url, init)

/** 从桌面端私有存储读取 API Key（含旧版钥匙串一次性迁移）；没有保存过时为 null */
export const loadKeychainApiKey = (): Promise<string | null> => invoke<string | null>('get_api_key')

/** 写入桌面端私有存储；null 表示删除 */
export const saveKeychainApiKey = (key: string | null): Promise<void> =>
  invoke<null>('set_api_key', { key }).then(() => undefined)

/** 从桌面端私有存储读取 Firecrawl API Key；没有保存过时为 null */
export const loadFirecrawlApiKey = (): Promise<string | null> =>
  invoke<string | null>('get_firecrawl_api_key')

/** 写入桌面端私有存储中的 Firecrawl API Key；null 表示删除 */
export const saveFirecrawlApiKey = (key: string | null): Promise<void> =>
  invoke<null>('set_firecrawl_api_key', { key }).then(() => undefined)

/**
 * 弹出系统保存对话框并写入文件。WKWebView 不支持 blob: 链接的 download 属性，
 * 桌面版只能由原生端保存。返回 false 表示用户取消。
 */
export const saveFileWithDialog = async (name: string, blob: Blob): Promise<boolean> =>
  invoke<boolean>('save_file', new Uint8Array(await blob.arrayBuffer()), {
    headers: { 'x-file-name': encodeURIComponent(name) },
  })

/** 在系统默认浏览器或外部应用中打开 URL */
export const openExternalUrl = async (url: string): Promise<void> => {
  if (!isDesktopApp) {
    window.open(url, '_blank', 'noopener,noreferrer')
    return
  }
  const { openUrl } = await import('@tauri-apps/plugin-opener')
  await openUrl(url)
}

/** 订阅桌面端菜单栏触发的打开设置事件，返回取消订阅函数 */
export const onOpenSettings = (handler: () => void): (() => void) => {
  if (!isDesktopApp) {
    return () => {}
  }
  let cancelled = false
  let unlisten: (() => void) | undefined
  void import('@tauri-apps/api/event').then(({ listen }) => {
    void listen('open-settings', handler).then((dispose) => {
      if (cancelled) {
        dispose()
      } else {
        unlisten = dispose
      }
    })
  })
  return () => {
    cancelled = true
    unlisten?.()
  }
}

/**
 * 桌面 webview 不会为 target="_blank" 打开新窗口：回复里的链接、来源和充值链接都会失效。
 * 默认将 http(s) 链接交给内置浏览器侧边栏；标记 data-external-browser="true" 或 mailto/tel
 * 仍用系统默认浏览器打开。
 */
export const openExternalLinksInBrowser = (onOpenHttpUrl?: (url: string) => void) => {
  document.addEventListener(
    'click',
    (event) => {
      if (event.defaultPrevented || event.button !== 0) {
        return
      }
      const link = (event.target as Element | null)?.closest?.('a[href]')
      if (!(link instanceof HTMLAnchorElement) || link.hasAttribute('download')) {
        return
      }
      const url = new URL(link.href, location.href)
      const external = url.origin !== location.origin || link.target === '_blank'
      if (!external || !['http:', 'https:', 'mailto:', 'tel:'].includes(url.protocol)) {
        return
      }
      event.preventDefault()
      const forceExternal = link.dataset.externalBrowser === 'true'
      if (
        !forceExternal &&
        onOpenHttpUrl &&
        (url.protocol === 'http:' || url.protocol === 'https:')
      ) {
        onOpenHttpUrl(url.href)
        return
      }
      void import('@tauri-apps/plugin-opener').then(({ openUrl }) => openUrl(url.href))
    },
    true
  )
}

// ---------- 内置浏览器原生多 Webview IPC ----------

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

export type BrowserNewTabPayload = {
  tabId: string
  url: string
}

export type BrowserBlockedPayload = {
  tabId: string
  url: string
  reason: string
}

export type BrowserSnapshotResult = {
  dataUrl: string
  width: number
  height: number
}

export type BrowserStateResult = {
  url: string
  canGoBack: boolean
  canGoForward: boolean
}

export const browserSetOptions = (allowLocalhost: boolean): Promise<void> =>
  invoke<null>('browser_set_options', { allowLocalhost }).then(() => undefined)

export const browserCreateTab = (options: {
  tabId: string
  url: string
  bounds: BrowserBounds
  visible: boolean
  zoom?: number
}): Promise<void> => invoke<null>('browser_create_tab', { options }).then(() => undefined)

export const browserCloseTab = (tabId: string): Promise<void> =>
  invoke<null>('browser_close_tab', { tabId }).then(() => undefined)

export const browserSetActiveTab = (
  tabId: string | null,
  bounds: BrowserBounds | null,
  visible: boolean
): Promise<void> =>
  invoke<null>('browser_set_active_tab', { tabId, bounds, visible }).then(() => undefined)

export const browserSetBounds = (bounds: BrowserBounds, zoom?: number): Promise<void> =>
  invoke<null>('browser_set_bounds', { bounds, zoom }).then(() => undefined)

export const browserSetZoom = (tabId: string, zoom: number): Promise<number> =>
  invoke<number>('browser_set_zoom', { tabId, zoom })

export const browserSetVisible = (visible: boolean): Promise<void> =>
  invoke<null>('browser_set_visible', { visible }).then(() => undefined)

export const browserNavigate = (
  tabId: string,
  url: string,
  initiator: 'user' | 'model' = 'user'
): Promise<string> => invoke<string>('browser_navigate', { tabId, url, initiator })

export const browserHistory = (
  tabId: string,
  action: 'back' | 'forward' | 'reload' | 'stop'
): Promise<void> => invoke<null>('browser_history', { tabId, action }).then(() => undefined)

export const browserGetState = (tabId: string): Promise<BrowserStateResult> =>
  invoke<BrowserStateResult>('browser_get_state', { tabId })

export const browserEvalJs = (
  tabId: string,
  script: string,
  isolatedWorld: boolean,
  timeoutMs?: number
): Promise<string> => invoke<string>('browser_eval_js', { tabId, script, isolatedWorld, timeoutMs })

export const browserTakeSnapshot = (
  tabId: string,
  maxWidth = 1280
): Promise<BrowserSnapshotResult> =>
  invoke<BrowserSnapshotResult>('browser_take_snapshot', { tabId, maxWidth })

export const browserClearData = (tabId: string): Promise<void> =>
  invoke<null>('browser_clear_data', { tabId }).then(() => undefined)

export const browserOpenDevtools = (tabId: string): Promise<void> =>
  invoke<null>('browser_open_devtools', { tabId }).then(() => undefined)

// ---------- 文件预览原生子 Webview IPC（HTML / PDF） ----------

export const previewSetContent = (
  bytes: Uint8Array,
  mimeType: 'text/html' | 'application/pdf'
): Promise<void> =>
  invoke<null>('preview_set_content', bytes, {
    headers: { 'x-mime-type': mimeType },
  }).then(() => undefined)

export const previewSetBounds = (bounds: BrowserBounds, zoom?: number): Promise<void> =>
  invoke<null>('preview_set_bounds', { bounds, zoom }).then(() => undefined)

export const previewSetVisible = (visible: boolean): Promise<void> =>
  invoke<null>('preview_set_visible', { visible }).then(() => undefined)

export const previewReload = (): Promise<void> =>
  invoke<null>('preview_reload').then(() => undefined)

export const previewTakeSnapshot = (maxWidth = 1280): Promise<BrowserSnapshotResult> =>
  invoke<BrowserSnapshotResult>('preview_take_snapshot', { maxWidth })

export const previewOpenDevtools = (): Promise<void> =>
  invoke<null>('preview_open_devtools').then(() => undefined)

const listenEvent = <T>(eventName: string, handler: (payload: T) => void): (() => void) => {
  if (!isDesktopApp) {
    return () => {}
  }
  let cancelled = false
  let unlisten: (() => void) | undefined
  void import('@tauri-apps/api/event').then(({ listen }) => {
    void listen<T>(eventName, (event) => handler(event.payload)).then((dispose) => {
      if (cancelled) {
        dispose()
      } else {
        unlisten = dispose
      }
    })
  })
  return () => {
    cancelled = true
    unlisten?.()
  }
}

export const onBrowserState = (handler: (payload: BrowserTabStatePayload) => void) =>
  listenEvent<BrowserTabStatePayload>('browser://state', handler)

export const onBrowserNewTabRequested = (handler: (payload: BrowserNewTabPayload) => void) =>
  listenEvent<BrowserNewTabPayload>('browser://new-tab-requested', handler)

export const onBrowserNavigationBlocked = (handler: (payload: BrowserBlockedPayload) => void) =>
  listenEvent<BrowserBlockedPayload>('browser://navigation-blocked', handler)

export const onBrowserDownloadBlocked = (handler: (payload: BrowserBlockedPayload) => void) =>
  listenEvent<BrowserBlockedPayload>('browser://download-blocked', handler)

// ---------- 桌面端原生沙箱 Python REPL IPC ----------

export type DesktopPresentedFile = {
  name: string
  mimeType: string
  dataBase64: string
}

export type DesktopPythonRunResponse = {
  stdout: string
  result: string | null
  error: string | null
  interrupted: boolean
  restarted: boolean
  images: string[]
  dropped: number
  files: DesktopPresentedFile[]
}

export const pythonRun = (
  code: string,
  sessionId?: string,
  timeoutMs?: number
): Promise<DesktopPythonRunResponse> =>
  invoke<DesktopPythonRunResponse>('python_run', {
    code,
    sessionId: sessionId ?? null,
    timeoutMs: timeoutMs ?? null,
  })

export const pythonInterrupt = (): Promise<void> =>
  invoke<null>('python_interrupt').then(() => undefined)

export const pythonReset = (): Promise<void> => invoke<null>('python_reset').then(() => undefined)

export const pythonStageUpload = (
  sessionId: string | undefined,
  fileId: string,
  name: string,
  bytes: Uint8Array
): Promise<string> =>
  invoke<string>('python_stage_upload', bytes, {
    headers: {
      ...(sessionId ? { 'x-session-id': encodeURIComponent(sessionId) } : {}),
      'x-file-id': encodeURIComponent(fileId),
      'x-file-name': encodeURIComponent(name),
    },
  })

export type DesktopPythonPhase = 'installing' | 'starting' | 'running'

export const onPythonPhase = (handler: (phase: DesktopPythonPhase) => void) =>
  listenEvent<DesktopPythonPhase>('python://phase', handler)

export type ManagedPythonStatus = {
  ready: boolean
  version: string
  venvPython: string | null
  packages: string[]
}

export const pythonRuntimeStatus = (): Promise<ManagedPythonStatus> =>
  invoke<ManagedPythonStatus>('python_runtime_status')

export const pythonRuntimeReset = (): Promise<void> =>
  invoke<null>('python_runtime_reset').then(() => undefined)
