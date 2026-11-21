import { useEffect, useId, useMemo, useRef, useState } from 'react'
import { isDesktopApp } from '../../../platform/desktop.js'
import type { BrowserViewportSpec } from '../../../services/sidePanel/viewport.js'
import { StageFrame } from '../../sidePanel/StageFrame.js'
import panelStyles from '../../sidePanel/SidePanel.module.css'
import styles from '../PreviewPanel.module.css'
import { NativePreviewSurface } from './NativePreviewSurface.js'

const injectErrorBridge = (html: string, instanceId: string): string => {
  const bridge = `<script>(function(){var id=${JSON.stringify(instanceId)};function report(msg){try{window.parent.postMessage({__dsPreviewError:String(msg||'Script error'),id:id},'*')}catch(e){}}window.addEventListener('error',function(e){report(e.message||(e.error&&e.error.message)||'Runtime error')});window.addEventListener('unhandledrejection',function(e){var r=e.reason;report(r&&r.message?r.message:String(r||'Unhandled rejection'))});})();</script>`
  if (/<head[\s>]/i.test(html)) {
    return html.replace(/<head(\s[^>]*)?>/i, (match) => `${match}${bridge}`)
  }
  if (/<html[\s>]/i.test(html)) {
    return html.replace(/<html(\s[^>]*)?>/i, (match) => `${match}<head>${bridge}</head>`)
  }
  return `<!doctype html><html><head>${bridge}</head><body>${html}</body></html>`
}

/**
 * HTML 交互文件预览：
 * - 桌面端使用隔离的原生子 Webview（ds-preview:// 协议 + 独立数据目录 + 无 IPC 权限），
 *   避开主窗口严格 CSP 对内联脚本的拦截；
 * - 网页端使用 sandbox="allow-scripts"（不含 allow-same-origin）的 iframe，在相同舞台比例中缩放。
 */
export const HtmlPreview = ({
  html,
  bytes,
  title,
  viewport,
  reloadKey,
  onViewportCommit,
}: {
  html: string
  bytes: Uint8Array
  title: string
  viewport: BrowserViewportSpec | null
  reloadKey: number
  onViewportCommit?: (next: BrowserViewportSpec) => void
}) => {
  const instanceId = useId()
  const iframeRef = useRef<HTMLIFrameElement>(null)
  const [runtimeError, setRuntimeError] = useState<string | null>(null)

  const wrappedHtml = useMemo(
    () => (isDesktopApp ? html : injectErrorBridge(html, instanceId)),
    [html, instanceId]
  )

  useEffect(() => {
    setRuntimeError(null)
  }, [html, reloadKey])

  useEffect(() => {
    if (isDesktopApp) {
      return
    }
    const onMessage = (event: MessageEvent) => {
      if (event.source !== iframeRef.current?.contentWindow) {
        return
      }
      const data = event.data as { __dsPreviewError?: unknown; id?: unknown } | null
      if (data && data.id === instanceId && typeof data.__dsPreviewError === 'string') {
        setRuntimeError(data.__dsPreviewError)
      }
    }
    window.addEventListener('message', onMessage)
    return () => window.removeEventListener('message', onMessage)
  }, [instanceId])

  if (isDesktopApp) {
    return (
      <NativePreviewSurface
        bytes={bytes}
        mimeType="text/html"
        viewport={viewport}
        reloadKey={reloadKey}
        onViewportCommit={onViewportCommit}
      />
    )
  }

  return (
    <StageFrame
      viewport={viewport}
      onViewportCommit={onViewportCommit}
      banner={runtimeError ? <div className={panelStyles.errorBanner}>{runtimeError}</div> : null}
    >
      {(fit, { resizing, viewport: liveViewport }) => {
        const scaledStyle =
          liveViewport && fit
            ? {
                width: liveViewport.width,
                height: liveViewport.height,
                transform: `scale(${fit.zoom})`,
                transformOrigin: 'top left',
              }
            : undefined
        return (
          <iframe
            key={reloadKey}
            ref={iframeRef}
            title={title}
            sandbox="allow-scripts"
            srcDoc={wrappedHtml}
            className={styles.iframeSurface}
            style={resizing ? { ...scaledStyle, pointerEvents: 'none' } : scaledStyle}
          />
        )
      }}
    </StageFrame>
  )
}
