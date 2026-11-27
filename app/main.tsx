import { ensureKatex } from '@deepseek-chat/lib-markdown'
import { createIndexedDbSessionStore, type StreamTrace } from '@deepseek-chat/slice-conversations'
import '@deepseek-chat/spine/tokens.css'
import '@fontsource-variable/google-sans-flex/opsz.css'
import { createRoot } from 'react-dom/client'
import { App } from './App.js'
import { AppErrorBoundary } from './AppErrorBoundary.js'
import './global.css'
import {
  desktopBrowserHost,
  desktopFetch,
  desktopPreviewHost,
  desktopScrape,
  isDesktopApp,
  loadFirecrawlApiKey,
  loadKeychainApiKey,
  onOpenSettings,
  onPythonPhase,
  openExternalLinksInBrowser,
  openExternalUrl,
  pythonInterrupt,
  pythonReset,
  pythonRun,
  pythonRuntimeReset,
  pythonRuntimeStatus,
  pythonStageUpload,
  saveFirecrawlApiKey,
  saveKeychainApiKey,
} from './platform/desktop.js'
import { createAppRuntime } from './runtime.js'
import { AppRuntimeProvider } from './RuntimeContext.js'
import { saveFile } from './saveFile.js'
import { localStore } from './storage.js'
import { createIndexedDbBlobStore } from './storage/indexedDbBlobStore.js'
import { setupDocumentTheme } from './theme.js'

const rootElement = document.getElementById('root') as HTMLElement

if (__DEV__ && new URLSearchParams(window.location.search).get('workbench') === '1') {
  if (new URLSearchParams(window.location.search).get('study') === 'minimap') {
    void import('./workbench/MinimapStudy.js').then(({ MinimapStudy }) => {
      createRoot(rootElement).render(<MinimapStudy />)
    })
  } else {
    void import('./workbench/Workbench.js').then(({ Workbench }) => {
      createRoot(rootElement).render(<Workbench />)
    })
  }
} else {
  ensureKatex()

  const runtime = createAppRuntime({
    store: localStore,
    blobs: createIndexedDbBlobStore(),
    sessions: createIndexedDbSessionStore(),
    fetch: isDesktopApp ? desktopFetch : (url, init) => fetch(url, init),
    apiOrigin: __API_ORIGIN__,
    platform: isDesktopApp ? 'desktop' : 'web',
    browserLanguage: typeof navigator === 'undefined' ? 'zh' : navigator.language,
    saveFile,
    syncDocumentTheme: true,
    desktop: isDesktopApp
      ? {
          browserHost: desktopBrowserHost,
          previewHost: desktopPreviewHost,
          pythonNative: {
            run: pythonRun,
            interrupt: pythonInterrupt,
            reset: pythonReset,
            stageUpload: pythonStageUpload,
            onPhase: onPythonPhase,
            runtimeStatus: pythonRuntimeStatus,
            resetRuntime: pythonRuntimeReset,
          },
          localScrape: desktopScrape,
          accountSecret: { load: loadKeychainApiKey, save: saveKeychainApiKey },
          firecrawlSecret: { load: loadFirecrawlApiKey, save: saveFirecrawlApiKey },
          openExternal: openExternalUrl,
          onOpenSettings,
        }
      : { openExternal: openExternalUrl },
    ...(__DEV__
      ? {
          onStreamTrace: (trace: StreamTrace) => {
            void fetch('/__dev/stream-trace', {
              method: 'POST',
              body: JSON.stringify({ at: new Date().toISOString(), ...trace }),
            }).catch(() => undefined)
          },
        }
      : {}),
  })

  setupDocumentTheme(runtime.slices.preferences)

  if (isDesktopApp && runtime.slices.browser) {
    const browserSlice = runtime.slices.browser
    openExternalLinksInBrowser((url) => {
      void browserSlice.openUrl(url, { initiator: 'user' })
    })
  }

  const render = () =>
    createRoot(rootElement).render(
      <AppRuntimeProvider runtime={runtime}>
        <AppErrorBoundary fullScreen>
          <App />
        </AppErrorBoundary>
      </AppRuntimeProvider>
    )

  void Promise.race([runtime.hydrate(), new Promise((resolve) => setTimeout(resolve, 2000))]).then(
    render
  )
}
