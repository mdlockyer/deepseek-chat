import { createRoot } from 'react-dom/client'
import { App } from './App.js'
import { AppErrorBoundary } from './AppErrorBoundary.js'
import { account, browser, overlays, webResearch } from './composition.js'
// 首屏渲染前创建 conversations slice（安装其端口）
import './conversations.js'
import { acquireSidePanelOverlayLock } from './rightPanel/state.js'
import { setupTheme } from './theme.js'
import { isDesktopApp, openExternalLinksInBrowser } from './platform/desktop.js'
import { ensureKatex } from '@deepseek-chat/lib-markdown'
import '@fontsource-variable/google-sans-flex'
import '@deepseek-chat/spine/tokens.css'
import './global.css'

const rootElement = document.getElementById('root') as HTMLElement

if (__DEV__ && new URLSearchParams(window.location.search).get('workbench') === '1') {
  void import('./workbench/Workbench.js').then(({ Workbench }) => {
    createRoot(rootElement).render(<Workbench />)
  })
} else {
  ensureKatex()
  setupTheme()
  // 原生浏览器视图画在页面之上，任何 HTML 浮层（菜单、弹窗）打开时都要让位
  let releaseUiOverlay: (() => void) | null = null
  overlays.subscribe((open) => {
    if (open) {
      if (!releaseUiOverlay) {
        const releaseBrowser = browser.acquireOverlayLock()
        const releasePanel = acquireSidePanelOverlayLock()
        releaseUiOverlay = () => {
          releaseBrowser()
          releasePanel()
        }
      }
    } else {
      releaseUiOverlay?.()
      releaseUiOverlay = null
    }
  })
  if (isDesktopApp) {
    openExternalLinksInBrowser((url) => {
      void browser.openUrl(url, { initiator: 'user' })
    })
  }

  const render = () =>
    createRoot(rootElement).render(
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
}
