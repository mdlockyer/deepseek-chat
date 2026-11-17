import { createRoot } from 'react-dom/client'
import { App } from './app/App.js'
import { setupTheme } from './app/theme.js'
import { isDesktopApp, openExternalLinksInBrowser } from './platform/desktop.js'
import { loadDesktopSettings } from './services/settings.js'
import { ensureKatex } from './services/markdown/katex.js'
import './app/theme.css'
import './app/global.css'

ensureKatex()
setupTheme()
if (isDesktopApp) {
  openExternalLinksInBrowser()
}

const render = () => createRoot(document.getElementById('root') as HTMLElement).render(<App />)

// 桌面版先从原生私有存储读入 API Key，避免首屏误判为未设置；网页版立即返回。
// 原生读取无响应或失败时最多等 2 秒，之后按未设置进入界面，避免白屏。
void Promise.race([
  loadDesktopSettings().catch(() => undefined),
  new Promise((resolve) => setTimeout(resolve, 2000)),
]).then(render)
