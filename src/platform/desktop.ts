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
 * 捕获这些点击，用系统默认浏览器打开 http(s)、mailto 与 tel 链接。
 */
export const openExternalLinksInBrowser = () => {
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
      void import('@tauri-apps/plugin-opener').then(({ openUrl }) => openUrl(url.href))
    },
    true
  )
}
