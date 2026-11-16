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

// 桌面版先从钥匙串读入 API Key，避免首屏误判为未设置；网页版立即返回。
void loadDesktopSettings().then(() => {
  createRoot(document.getElementById('root') as HTMLElement).render(<App />)
})
