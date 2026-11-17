import { ModuleWorker } from './module-worker.js'

/**
 * 浏览器内的 Python REPL：Pyodide 跑在模块 Web Worker（worker.ts）里，所有调用共用一个持久的 __main__ 命名空间，
 * 支持顶层 await。Worker 首次调用时才创建；Pyodide 的位置见 pyodideIndexURL。
 * 中断没有 SharedArrayBuffer 可用（静态托管无法设置 COOP/COEP），停止时直接终止 Worker，变量随之丢失。
 */

/** 须与 package.json 中 pyodide 开发依赖的版本一致（scripts/fetch-pyodide.mjs 从中复制运行时） */
const PYODIDE_VERSION = '314.0.8'
/**
 * Pyodide 的位置：桌面版构建（PYODIDE_LOCAL=1）随应用打包在 pyodide/ 目录，
 * 网页版从 jsDelivr 加载。
 */
const pyodideIndexURL = () =>
  __PYODIDE_LOCAL__
    ? new URL('pyodide/', document.baseURI).href
    : `https://cdn.jsdelivr.net/pyodide/v${PYODIDE_VERSION}/full/`

/** 启动内核、加载代码用到的包的时限（首次下载 Pyodide 与大型包较慢） */
const STARTUP_TIMEOUT_MS = 180_000
/** 单次代码执行的时限，超时终止 Worker */
const RUN_TIMEOUT_MS = 120_000

export type PythonPhase = 'starting' | 'running'

/** 回传给模型的文本上限（字符），超出部分截断 */
const OUTPUT_LIMIT = 30_000

export type PythonRunResult = {
  status: 'ok' | 'error' | 'aborted'
  /** 回传给模型的文本 */
  text: string
  /** 代码产生的图像（data URL）：matplotlib 图与 show() 的输出，回传给模型并展示给用户 */
  images: string[]
  /** present_file() 交给用户下载的文件 */
  files: PresentedFile[]
  durationMs: number
}

export type PresentedFile = { name: string; mimeType: string; data: Uint8Array }

type WorkerReply =
  | { id: number; phase: 'running'; ok?: undefined }
  | { id: number; phase?: undefined; ok: false; error: string }
  | {
      id: number
      phase?: undefined
      ok: true
      stdout: string
      result: string | null
      error: string | null
      images: string[]
      dropped?: number
      files?: PresentedFile[]
    }

let worker: Worker | null = null
let nextId = 1
/** 当前独占内核状态（变量、文件）的会话 ID */
let ownerSessionId: string | null = null
/** 上一次调用被终止导致内核重启，下次结果前附加提示 */
let restartNotice = false
/** 主线程串行队列，避免多会话并发调用时状态互相覆盖 */
let runQueue: Promise<void> = Promise.resolve()

const getWorker = () => {
  if (!worker) {
    worker = new ModuleWorker(new URL('./worker.ts', import.meta.url))
    worker.postMessage({ type: 'init', indexURL: pyodideIndexURL() })
  }
  return worker
}

export const getPythonKernelSessionId = () => ownerSessionId

/** 终止内核，丢弃全部变量；notify=false 用于切换或清理会话时静默重置 */
export const resetPythonKernel = (notify = true) => {
  if (worker) {
    worker.terminate()
    worker = null
    restartNotice = notify
  } else if (!notify) {
    restartNotice = false
  }
  ownerSessionId = null
}

export const formatBytes = (bytes: number) =>
  bytes < 1024
    ? `${bytes} B`
    : bytes < 1024 * 1024
      ? `${(bytes / 1024).toFixed(1)} KB`
      : `${(bytes / 1024 / 1024).toFixed(1)} MB`

const truncate = (text: string) =>
  text.length > OUTPUT_LIMIT
    ? `${text.slice(0, OUTPUT_LIMIT)}\n… [output truncated: ${text.length - OUTPUT_LIMIT} more characters]`
    : text

const RESTART_NOTICE =
  '<python_kernel_reset>\nThe Python kernel was restarted. Variables, imports and functions from earlier calls are gone; recreate them before use.\n</python_kernel_reset>'

/** 在持久内核中执行一段代码；signal 中止时终止 Worker */
export const runPython = (
  code: string,
  signal: AbortSignal,
  onPhase?: (phase: PythonPhase) => void,
  sessionId?: string
): Promise<PythonRunResult> => {
  if (signal.aborted) {
    return Promise.resolve({
      status: 'aborted',
      text: 'Interrupted.',
      images: [],
      files: [],
      durationMs: 0,
    })
  }
  return new Promise((resolve) => {
    let started = false
    const onQueuedAbort = () => {
      if (!started) {
        resolve({
          status: 'aborted',
          text: 'Interrupted by the user.',
          images: [],
          files: [],
          durationMs: 0,
        })
      }
    }
    signal.addEventListener('abort', onQueuedAbort, { once: true })
    const task = runQueue.then(() => {
      signal.removeEventListener('abort', onQueuedAbort)
      if (signal.aborted) {
        return {
          status: 'aborted' as const,
          text: 'Interrupted by the user.',
          images: [],
          files: [],
          durationMs: 0,
        }
      }
      started = true
      return executePython(code, signal, onPhase, sessionId)
    })
    runQueue = task.then(
      () => {},
      () => {}
    )
    void task.then(resolve)
  })
}

const executePython = (
  code: string,
  signal: AbortSignal,
  onPhase?: (phase: PythonPhase) => void,
  sessionId?: string
): Promise<PythonRunResult> => {
  if (signal.aborted) {
    return Promise.resolve({
      status: 'aborted',
      text: 'Interrupted.',
      images: [],
      files: [],
      durationMs: 0,
    })
  }
  if (sessionId !== undefined && ownerSessionId !== null && ownerSessionId !== sessionId) {
    resetPythonKernel(false)
  }
  if (sessionId !== undefined) {
    ownerSessionId = sessionId
  }
  const startedAt = Date.now()
  const notice = restartNotice
  restartNotice = false
  const prefix = (text: string) => (notice ? `${RESTART_NOTICE}\n\n${text}` : text)
  const id = nextId++
  const target = getWorker()
  return new Promise((resolve) => {
    let timer = 0
    const startTimer = (ms: number, message: string) => {
      clearTimeout(timer)
      timer = window.setTimeout(() => {
        resetPythonKernel()
        restartNotice = false
        finish({ status: 'error', text: prefix(message), images: [] })
      }, ms)
    }
    const finish = (
      result: Omit<PythonRunResult, 'durationMs' | 'files'> & { files?: PresentedFile[] }
    ) => {
      clearTimeout(timer)
      target.removeEventListener('message', onMessage)
      target.removeEventListener('error', onError)
      signal.removeEventListener('abort', onAbort)
      resolve({ ...result, files: result.files ?? [], durationMs: Date.now() - startedAt })
    }
    function onMessage({ data }: MessageEvent<WorkerReply>) {
      if (data.id !== id) {
        return
      }
      if (data.phase === 'running') {
        onPhase?.('running')
        startTimer(
          RUN_TIMEOUT_MS,
          `Timed out after ${RUN_TIMEOUT_MS / 1000} s, so the kernel was restarted and all variables are gone. Network requests that never answer, or long loops, cause this; split the work into smaller calls.`
        )
        return
      }
      if (!data.ok) {
        // 启动失败：丢弃 Worker，下次重试
        worker?.terminate()
        worker = null
        finish({ status: 'error', text: prefix(data.error), images: [] })
        return
      }
      const parts = [data.stdout.replace(/\n$/, ''), data.result, data.error]
      const text = parts.filter((part): part is string => !!part).join('\n')
      const images = data.images ?? []
      const imageNote =
        (images.length
          ? `\n[${images.length} image${images.length === 1 ? '' : 's'} attached below]`
          : '') +
        (data.dropped
          ? `\n[${data.dropped} more image${data.dropped === 1 ? '' : 's'} not attached: at most 6 per call]`
          : '')
      const files = data.files ?? []
      const fileNote = files.length
        ? `\n[Offered to the user for download: ${files
            .map((file) => `${file.name} (${formatBytes(file.data.byteLength)})`)
            .join(', ')}]`
        : ''
      finish({
        status: data.error ? 'error' : 'ok',
        text: prefix(truncate(text || '(no output)') + imageNote + fileNote),
        images,
        files,
      })
    }
    function onError(event: ErrorEvent) {
      resetPythonKernel()
      restartNotice = false
      finish({ status: 'error', text: prefix(`Python worker error: ${event.message}`), images: [] })
    }
    function onAbort() {
      resetPythonKernel()
      finish({
        status: 'aborted',
        text: 'Interrupted by the user; the kernel was restarted.',
        images: [],
      })
    }
    target.addEventListener('message', onMessage)
    target.addEventListener('error', onError)
    signal.addEventListener('abort', onAbort, { once: true })
    onPhase?.('starting')
    startTimer(
      STARTUP_TIMEOUT_MS,
      `Python did not start within ${STARTUP_TIMEOUT_MS / 1000} s (downloading Pyodide or packages from cdn.jsdelivr.net), so the kernel was restarted.`
    )
    target.postMessage({ id, code })
  })
}

export const PYTHON_TOOL_NAME = 'python'

/** 模型可见的工具定义（客户端工具不带 type 字段） */
export const PYTHON_TOOL = {
  name: PYTHON_TOOL_NAME,
  description: [
    "Run Python code in a persistent Python 3 REPL (Pyodide, running in the user's browser).",
    'Variables, imports and functions persist between calls in this conversation; top-level `await` works.',
    'The result is stdout/stderr, then the repr of the trailing expression, then any traceback.',
    'numpy, pandas, scipy, sympy, matplotlib and other Pyodide packages are imported automatically; install pure-Python packages with `import micropip; await micropip.install("name")`.',
    'You can see images: every matplotlib figure, and anything passed to `show(img, ...)` (a PIL image, numpy array, image bytes, file path or matplotlib figure), is sent to you as an image right after the tool result, and also shown to the user. Images are downscaled to 1024 px, at most 6 per call; OpenCV arrays are BGR, so convert with cv2.cvtColor first. Images from earlier calls may be dropped later to keep requests small; call show() again if you need them.',
    'To give the user a file, write it in the Python filesystem (e.g. /tmp/out.csv) and call `present_file(path, name=None, mime_type=None)`; it appears as a download in the chat (at most 10 files of 50 MB each per call). You do not see the file contents through this.',
    "There is no shell, no subprocess and no access to the user's files.",
    'HTTP goes through the browser: use `from pyodide.http import pyfetch` (CORS applies).',
    'Use it for calculation, data analysis, simulations and checking your work. Put independent steps in one call.',
  ].join(' '),
  input_schema: {
    type: 'object',
    required: ['code'],
    properties: { code: { type: 'string', description: 'Python code to run.' } },
  },
}

// 开发时本模块变更不做热替换：旧 Worker 与旧工具说明会留在页面里，直接整页刷新。
// 不能写成 import.meta.webpackHot?.decline()：生产构建会把整个表达式替换成 (void 0)() 并在启动时抛错。
const hot = (import.meta as { webpackHot?: { decline: () => void } }).webpackHot
if (hot) {
  hot.decline()
}
