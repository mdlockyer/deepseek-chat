/**
 * App Shell composition root: boots the Spine and instantiates slices with their host adapters.
 * No domain logic belongs here — only wiring.
 */
import { createAccountSlice } from '@deepseek-chat/slice-account'
import { createBrowserSlice } from '@deepseek-chat/slice-browser'
import { createPreferencesSlice } from '@deepseek-chat/slice-preferences'
import { createPythonSlice } from '@deepseek-chat/slice-python'
import { createVoiceSlice } from '@deepseek-chat/slice-voice'
import { createWebResearchSlice } from '@deepseek-chat/slice-web-research'
import type { SessionDeleted, SessionHistoryReplaced } from '@deepseek-chat/spine/facts/session'
import { EventLog } from '@deepseek-chat/spine/runtime'
import {
  desktopBrowserHost,
  desktopFetch,
  isDesktopApp,
  loadFirecrawlApiKey,
  loadKeychainApiKey,
  onPythonPhase,
  openExternalUrl,
  pythonInterrupt,
  pythonReset,
  pythonRun,
  pythonRuntimeReset,
  pythonRuntimeStatus,
  pythonStageUpload,
  saveFirecrawlApiKey,
  saveKeychainApiKey,
} from '../platform/desktop.js'
import { API_ORIGIN } from '../services/api/client.js'
import { createPanelSlot } from './rightPanel/panelSlot.js'
import {
  clearAllSidePanelSessions,
  disposeSidePanelSession,
  setActiveSidePanelSession,
} from './rightPanel/state.js'
import { localStore } from './storage.js'

/** 须与 package.json 中 pyodide 开发依赖的版本一致（scripts/fetch-pyodide.mjs 从中复制运行时） */
const PYODIDE_VERSION = '314.0.8'

/** Pyodide 的位置：桌面版构建（PYODIDE_LOCAL=1）随应用打包在 pyodide/ 目录，网页版从 jsDelivr 加载。 */
const pyodideIndexURL = () =>
  __PYODIDE_LOCAL__
    ? new URL('pyodide/', document.baseURI).href
    : `https://cdn.jsdelivr.net/pyodide/v${PYODIDE_VERSION}/full/`

export const spine = new EventLog()

/** 先于首屏创建：恢复界面语言、主题与位置 */
export const preferences = createPreferencesSlice({
  store: localStore,
  browserLanguage: typeof navigator === 'undefined' ? 'zh' : navigator.language,
})

/** 桌面版走原生 HTTP（不受 CORS 限制），网页版走 WebView fetch */
const httpFetch = isDesktopApp ? desktopFetch : (url: string, init: RequestInit) => fetch(url, init)

/** 桌面版密钥存在应用私有存储，网页版存在 localStorage */
export const account = createAccountSlice({
  store: localStore,
  secret: isDesktopApp ? { load: loadKeychainApiKey, save: saveKeychainApiKey } : null,
  fetch: httpFetch,
  apiOrigin: API_ORIGIN,
})

export const python = createPythonSlice({
  log: spine,
  native: isDesktopApp
    ? {
        run: pythonRun,
        interrupt: pythonInterrupt,
        reset: pythonReset,
        stageUpload: pythonStageUpload,
        onPhase: onPythonPhase,
        runtimeStatus: pythonRuntimeStatus,
        resetRuntime: pythonRuntimeReset,
      }
    : null,
  pyodideIndexURL: pyodideIndexURL(),
})

export const webResearch = createWebResearchSlice({
  fetch: httpFetch,
  store: localStore,
  secret: isDesktopApp ? { load: loadFirecrawlApiKey, save: saveFirecrawlApiKey } : null,
})

export const voice = createVoiceSlice({
  fetch: httpFetch,
  apiOrigin: API_ORIGIN,
  apiKey: () => account.getApiKey(),
  store: localStore,
})

export const browser = createBrowserSlice({
  log: spine,
  host: isDesktopApp ? desktopBrowserHost : null,
  panel: createPanelSlot('browser'),
  store: localStore,
  openExternal: openExternalUrl,
  // 聊天 store 依赖本模块，按需加载以避免循环引用
  stopController: (sessionId) =>
    void import('../services/chat/store.js').then(({ stopReply }) => stopReply(sessionId)),
})

/** 右侧面板跟随当前会话：面板栏位与各 slice 的会话状态一起切换 */
export const setActivePanelSession = (sessionId: string | null) => {
  setActiveSidePanelSession(sessionId)
  browser.setActiveSession(sessionId)
}

// 会话删除或历史被替换后清理右侧面板的会话状态（各 slice 自己订阅同样的事实）
spine.subscribe<SessionDeleted>('SessionDeleted', ({ fact }) =>
  disposeSidePanelSession(fact.sessionId)
)
spine.subscribe<SessionHistoryReplaced>('SessionHistoryReplaced', () => clearAllSidePanelSessions())
