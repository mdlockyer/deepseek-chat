import { ModuleWorker } from './module-worker.js'

/**
 * Python REPL：
 * - 桌面版（Tauri）：通过注入的 NativePythonHost 驱动 Rust 侧 OS 级原生沙箱（macOS Seatbelt /
 *   Linux Landlock+seccomp）里的持久 CPython 子进程，支持 SIGINT 优雅中断（保留变量）。
 * - 网页版：Pyodide 跑在模块 Web Worker（worker.ts）里，共用持久 __main__ 命名空间。
 *
 * Behaviour is specified in ../SPEC.md.
 */

export type PythonPhase = 'installing' | 'starting' | 'running'

export type PresentedFile = { name: string; mimeType: string; data: Uint8Array }

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

export type PythonUpload = {
  id: string
  name: string
  loadBlob: () => Promise<Blob | undefined>
}

export type NativeRunResponse = {
  stdout: string
  result: string | null
  error: string | null
  interrupted: boolean
  restarted: boolean
  images: string[]
  dropped: number
  files: { name: string; mimeType: string; dataBase64: string }[]
}

export type NativeRuntimeStatus = {
  ready: boolean
  version: string
  venvPython: string | null
  packages: string[]
}

/** The desktop host's sandboxed CPython, injected by the app shell. */
export type NativePythonHost = {
  run(code: string, sessionId: string | undefined, timeoutMs: number): Promise<NativeRunResponse>
  interrupt(): Promise<void>
  reset(): Promise<void>
  stageUpload(
    sessionId: string | undefined,
    fileId: string,
    name: string,
    bytes: Uint8Array
  ): Promise<unknown>
  /** Subscribes to engine phase changes; returns an unsubscribe function. */
  onPhase(handler: (phase: PythonPhase) => void): () => void
  runtimeStatus(): Promise<NativeRuntimeStatus>
  resetRuntime(): Promise<void>
}

export type WorkerLike = Pick<
  Worker,
  'postMessage' | 'terminate' | 'addEventListener' | 'removeEventListener'
>

export type PythonParams = {
  /** 单次代码执行的时限 */
  runTimeoutMs: number
  /** 网页版启动内核、加载包的时限（首次下载 Pyodide 与大型包较慢） */
  startupTimeoutMs: number
  /** 回传给模型的文本上限（字符），超出部分截断 */
  outputLimit: number
}

export const DEFAULT_PYTHON_PARAMS: PythonParams = {
  runTimeoutMs: 120_000,
  startupTimeoutMs: 180_000,
  outputLimit: 30_000,
}

export type KernelDeps = {
  native: NativePythonHost | null
  /** Web engine: where Pyodide is loaded from. */
  pyodideIndexURL: string
  spawnWorker: () => WorkerLike
  now: () => number
  params: PythonParams
}

export type RunOptions = {
  signal: AbortSignal
  sessionId?: string
  uploads?: PythonUpload[]
  onPhase?: (phase: PythonPhase) => void
}

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

export const spawnPyodideWorker = (): WorkerLike =>
  new ModuleWorker(new URL('./worker.ts', import.meta.url))

const RESTART_NOTICE =
  '<python_kernel_reset>\nThe Python kernel was restarted. Variables, imports and functions from earlier calls are gone; recreate them before use.\n</python_kernel_reset>'

const formatBytes = (bytes: number) =>
  bytes < 1024
    ? `${bytes} B`
    : bytes < 1024 * 1024
      ? `${(bytes / 1024).toFixed(1)} KB`
      : `${(bytes / 1024 / 1024).toFixed(1)} MB`

const base64ToBytes = (base64: string): Uint8Array => {
  const binary = atob(base64)
  const bytes = new Uint8Array(binary.length)
  for (let i = 0; i < binary.length; i += 1) {
    bytes[i] = binary.charCodeAt(i)
  }
  return bytes
}

const abortedResult = (text: string, durationMs = 0): PythonRunResult => ({
  status: 'aborted',
  text,
  images: [],
  files: [],
  durationMs,
})

export const createKernel = (deps: KernelDeps) => {
  const { native, now, params } = deps

  let worker: WorkerLike | null = null
  let nextId = 1
  /** 当前独占内核状态（变量、文件）的会话 ID */
  let ownerSessionId: string | null = null
  /** 当前会话已同步到桌面端只读 uploads/ 的附件 ID */
  const syncedUploads = new Set<string>()
  /** 上一次调用被终止导致内核重启，下次结果前附加提示 */
  let restartNotice = false
  /** 主线程串行队列，避免多会话并发调用时状态互相覆盖 */
  let runQueue: Promise<void> = Promise.resolve()

  const getWorker = () => {
    if (!worker) {
      worker = deps.spawnWorker()
      worker.postMessage({ type: 'init', indexURL: deps.pyodideIndexURL })
    }
    return worker
  }

  /** 终止内核，丢弃全部变量；notify=false 用于切换或清理会话时静默重置 */
  const reset = (notify = true) => {
    syncedUploads.clear()
    if (native) {
      void native.reset()
      if (ownerSessionId !== null) {
        restartNotice = notify
      } else if (!notify) {
        restartNotice = false
      }
      ownerSessionId = null
      return
    }
    if (worker) {
      worker.terminate()
      worker = null
      restartNotice = notify
    } else if (!notify) {
      restartNotice = false
    }
    ownerSessionId = null
  }

  const truncate = (text: string) =>
    text.length > params.outputLimit
      ? `${text.slice(0, params.outputLimit)}\n… [output truncated: ${text.length - params.outputLimit} more characters]`
      : text

  const formatToolOutput = (
    stdout: string,
    result: string | null,
    error: string | null,
    images: string[],
    dropped: number,
    files: PresentedFile[]
  ) => {
    const parts = [stdout.replace(/\n$/, ''), result, error]
    const text = parts.filter((part): part is string => !!part).join('\n')
    const imageNote =
      (images.length
        ? `\n[${images.length} image${images.length === 1 ? '' : 's'} attached below]`
        : '') +
      (dropped
        ? `\n[${dropped} more image${dropped === 1 ? '' : 's'} not attached: at most 6 per call]`
        : '')
    const fileNote = files.length
      ? `\n[Offered to the user for download: ${files
          .map((file) => `${file.name} (${formatBytes(file.data.byteLength)})`)
          .join(', ')}]`
      : ''
    return truncate(text || '(no output)') + imageNote + fileNote
  }

  const syncNativeUploads = async (
    host: NativePythonHost,
    sessionId: string | undefined,
    uploads: PythonUpload[] | undefined,
    signal: AbortSignal
  ) => {
    if (!uploads?.length) {
      return
    }
    for (const upload of uploads) {
      if (signal.aborted) {
        return
      }
      const key = `${sessionId ?? ''}:${upload.id}`
      if (syncedUploads.has(key)) {
        continue
      }
      try {
        const blob = await upload.loadBlob()
        if (!blob || signal.aborted) {
          continue
        }
        const bytes = new Uint8Array(await blob.arrayBuffer())
        if (signal.aborted) {
          return
        }
        await host.stageUpload(sessionId, upload.id, upload.name, bytes)
        syncedUploads.add(key)
      } catch {
        // 单个附件同步失败不阻断本次执行（SPEC.md「Known gaps」）
      }
    }
  }

  const executeNative = async (
    host: NativePythonHost,
    code: string,
    { signal, sessionId, uploads, onPhase }: RunOptions
  ): Promise<PythonRunResult> => {
    if (signal.aborted) {
      return abortedResult('Interrupted.')
    }
    if (sessionId !== undefined && ownerSessionId !== null && ownerSessionId !== sessionId) {
      restartNotice = false
      syncedUploads.clear()
    }
    if (sessionId !== undefined) {
      ownerSessionId = sessionId
    }
    const startedAt = now()
    const notice = restartNotice
    restartNotice = false
    const prefix = (text: string) => (notice ? `${RESTART_NOTICE}\n\n${text}` : text)

    let aborted = false
    const onAbort = () => {
      aborted = true
      void host.interrupt()
    }
    signal.addEventListener('abort', onAbort, { once: true })
    const unlistenPhase = host.onPhase((phase) => onPhase?.(phase))
    onPhase?.('starting')

    try {
      await syncNativeUploads(host, sessionId, uploads, signal)
      if (signal.aborted) {
        return abortedResult('Interrupted by the user.', now() - startedAt)
      }
      const response = await host.run(code, sessionId, params.runTimeoutMs)
      const files: PresentedFile[] = response.files.map((file) => ({
        name: file.name,
        mimeType: file.mimeType,
        data: base64ToBytes(file.dataBase64),
      }))

      if (aborted || response.interrupted) {
        if (response.restarted) {
          restartNotice = true
          return abortedResult(
            'Interrupted by the user; the kernel was restarted.',
            now() - startedAt
          )
        }
        return {
          status: 'aborted',
          text: prefix(
            formatToolOutput(
              response.stdout,
              response.result,
              response.error ?? 'Interrupted by the user.',
              response.images,
              response.dropped,
              files
            )
          ),
          images: response.images,
          files,
          durationMs: now() - startedAt,
        }
      }

      if (response.restarted) {
        restartNotice = true
        return {
          status: 'error',
          text: prefix(
            response.error ||
              'The Python kernel exited unexpectedly and will restart on the next call.'
          ),
          images: [],
          files: [],
          durationMs: now() - startedAt,
        }
      }

      return {
        status: response.error ? 'error' : 'ok',
        text: prefix(
          formatToolOutput(
            response.stdout,
            response.result,
            response.error,
            response.images,
            response.dropped,
            files
          )
        ),
        images: response.images,
        files,
        durationMs: now() - startedAt,
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      return {
        status: aborted ? 'aborted' : 'error',
        text: prefix(aborted ? 'Interrupted by the user.' : `Failed to run Python: ${message}`),
        images: [],
        files: [],
        durationMs: now() - startedAt,
      }
    } finally {
      signal.removeEventListener('abort', onAbort)
      unlistenPhase()
    }
  }

  const executeWeb = (
    code: string,
    { signal, sessionId, onPhase }: RunOptions
  ): Promise<PythonRunResult> => {
    if (signal.aborted) {
      return Promise.resolve(abortedResult('Interrupted.'))
    }
    if (sessionId !== undefined && ownerSessionId !== null && ownerSessionId !== sessionId) {
      reset(false)
    }
    if (sessionId !== undefined) {
      ownerSessionId = sessionId
    }
    const startedAt = now()
    const notice = restartNotice
    restartNotice = false
    const prefix = (text: string) => (notice ? `${RESTART_NOTICE}\n\n${text}` : text)
    const id = nextId++
    const target = getWorker()
    return new Promise((resolve) => {
      let timer: ReturnType<typeof setTimeout> | undefined
      const startTimer = (ms: number, message: string) => {
        clearTimeout(timer)
        timer = setTimeout(() => {
          reset()
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
        resolve({ ...result, files: result.files ?? [], durationMs: now() - startedAt })
      }
      function onMessage({ data }: MessageEvent<WorkerReply>) {
        if (data.id !== id) {
          return
        }
        if (data.phase === 'running') {
          onPhase?.('running')
          startTimer(
            params.runTimeoutMs,
            `Timed out after ${params.runTimeoutMs / 1000} s, so the kernel was restarted and all variables are gone. Network requests that never answer, or long loops, cause this; split the work into smaller calls.`
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
        const images = data.images ?? []
        const files = data.files ?? []
        finish({
          status: data.error ? 'error' : 'ok',
          text: prefix(
            formatToolOutput(data.stdout, data.result, data.error, images, data.dropped ?? 0, files)
          ),
          images,
          files,
        })
      }
      function onError(event: ErrorEvent) {
        reset()
        restartNotice = false
        finish({
          status: 'error',
          text: prefix(`Python worker error: ${event.message}`),
          images: [],
        })
      }
      function onAbort() {
        reset()
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
        params.startupTimeoutMs,
        `Python did not start within ${params.startupTimeoutMs / 1000} s (downloading Pyodide or packages from cdn.jsdelivr.net), so the kernel was restarted.`
      )
      target.postMessage({ id, code })
    })
  }

  /** 在持久内核中执行一段代码；按调用顺序串行执行，结果总是 resolve */
  const run = (code: string, options: RunOptions): Promise<PythonRunResult> => {
    const { signal } = options
    if (signal.aborted) {
      return Promise.resolve(abortedResult('Interrupted.'))
    }
    return new Promise((resolve) => {
      let started = false
      const onQueuedAbort = () => {
        if (!started) {
          resolve(abortedResult('Interrupted by the user.'))
        }
      }
      signal.addEventListener('abort', onQueuedAbort, { once: true })
      const task = runQueue.then(() => {
        signal.removeEventListener('abort', onQueuedAbort)
        if (signal.aborted) {
          return abortedResult('Interrupted by the user.')
        }
        started = true
        return native ? executeNative(native, code, options) : executeWeb(code, options)
      })
      runQueue = task.then(
        () => {},
        () => {}
      )
      void task.then(resolve)
    })
  }

  return {
    run,
    reset,
    ownerSessionId: () => ownerSessionId,
  }
}
