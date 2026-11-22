import { onOverlayChange } from '@deepseek-chat/spine/design'
import { createRoot } from 'react-dom/client'
import { App } from './app/App.js'
import { AppErrorBoundary } from './app/AppErrorBoundary.js'
import { account, browser, webResearch } from './app/composition.js'
import { acquireSidePanelOverlayLock } from './app/rightPanel/state.js'
import { setupTheme } from './app/theme.js'
import { isDesktopApp, openExternalLinksInBrowser } from './platform/desktop.js'
import { ensureKatex } from '@deepseek-chat/lib-markdown'
import '@fontsource-variable/google-sans-flex'
import './app/theme.css'
import './app/global.css'

ensureKatex()
setupTheme()
// 原生浏览器视图画在页面之上，任何 HTML 浮层（菜单、弹窗）打开时都要让位
let releaseBrowserOverlay: (() => void) | null = null
onOverlayChange((open) => {
  if (open) {
    if (!releaseBrowserOverlay) {
      const releaseBrowser = browser.acquireOverlayLock()
      const releasePanel = acquireSidePanelOverlayLock()
      releaseBrowserOverlay = () => {
        releaseBrowser()
        releasePanel()
      }
    }
  } else {
    releaseBrowserOverlay?.()
    releaseBrowserOverlay = null
  }
})
if (isDesktopApp) {
  openExternalLinksInBrowser((url) => {
    void browser.openUrl(url, { initiator: 'user' })
  })
}

const render = () =>
  createRoot(document.getElementById('root') as HTMLElement).render(
    <AppErrorBoundary fullScreen>
      <App />
    </AppErrorBoundary>
  )

// 桌面版先从原生私有存储读入密钥（API Key 与 Firecrawl Key），避免首屏误判为未设置；网页版立即返回。
// 原生读取无响应或失败时最多等 2 秒，之后按未设置进入界面，避免白屏。
void Promise.race([
  Promise.all([account.hydrate(), webResearch.hydrate()]),
  new Promise((resolve) => setTimeout(resolve, 2000)),
]).then(render)
