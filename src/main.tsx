import { onOverlayChange } from '@deepseek-chat/spine/design'
import { createRoot } from 'react-dom/client'
import { App } from './app/App.js'
import { AppErrorBoundary } from './app/AppErrorBoundary.js'
import { setupTheme } from './app/theme.js'
import { isDesktopApp, openExternalLinksInBrowser } from './platform/desktop.js'
import { acquireBrowserOverlayLock, openUrlInBrowserPanel } from './services/browser/state.js'
import { loadDesktopSettings } from './services/settings.js'
import { ensureKatex } from './services/markdown/katex.js'
import '@fontsource-variable/google-sans-flex'
import './app/theme.css'
import './app/global.css'

ensureKatex()
setupTheme()
// 原生浏览器视图画在页面之上，任何 HTML 浮层（菜单、弹窗）打开时都要让位
let releaseBrowserOverlay: (() => void) | null = null
onOverlayChange((open) => {
  if (open) {
    releaseBrowserOverlay ??= acquireBrowserOverlayLock()
  } else {
    releaseBrowserOverlay?.()
    releaseBrowserOverlay = null
  }
})
if (isDesktopApp) {
  openExternalLinksInBrowser((url) => {
    void openUrlInBrowserPanel(url, { initiator: 'user' })
  })
}

const render = () =>
  createRoot(document.getElementById('root') as HTMLElement).render(
    <AppErrorBoundary fullScreen>
      <App />
    </AppErrorBoundary>
  )

// 桌面版先从原生私有存储读入 API Key，避免首屏误判为未设置；网页版立即返回。
// 原生读取无响应或失败时最多等 2 秒，之后按未设置进入界面，避免白屏。
void Promise.race([
  loadDesktopSettings().catch(() => undefined),
  new Promise((resolve) => setTimeout(resolve, 2000)),
]).then(render)
