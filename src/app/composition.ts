/**
 * App Shell composition root: boots the Spine and instantiates slices with their host adapters.
 * No domain logic belongs here — only wiring.
 */
import { createPythonSlice } from '@deepseek-chat/slice-python'
import { createWebResearchSlice } from '@deepseek-chat/slice-web-research'
import { EventLog } from '@deepseek-chat/spine/runtime'
import {
  desktopFetch,
  isDesktopApp,
  onPythonPhase,
  pythonInterrupt,
  pythonReset,
  pythonRun,
  pythonRuntimeReset,
  pythonRuntimeStatus,
  pythonStageUpload,
} from '../platform/desktop.js'
import { useSettings } from '../services/settings.js'

/** 须与 package.json 中 pyodide 开发依赖的版本一致（scripts/fetch-pyodide.mjs 从中复制运行时） */
const PYODIDE_VERSION = '314.0.8'

/** Pyodide 的位置：桌面版构建（PYODIDE_LOCAL=1）随应用打包在 pyodide/ 目录，网页版从 jsDelivr 加载。 */
const pyodideIndexURL = () =>
  __PYODIDE_LOCAL__
    ? new URL('pyodide/', document.baseURI).href
    : `https://cdn.jsdelivr.net/pyodide/v${PYODIDE_VERSION}/full/`

export const spine = new EventLog()

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
  // 桌面版走原生 HTTP（不受 CORS 限制），网页版走 WebView fetch
  fetch: isDesktopApp ? desktopFetch : (url, init) => fetch(url, init),
  // Firecrawl Key 仍由设置保存，待设置按 slice 拆分后归 web-research 所有
  apiKey: () => useSettings.getState().firecrawlApiKey,
})
