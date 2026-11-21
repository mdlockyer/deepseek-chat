import type { SessionDeleted, SessionHistoryReplaced } from '@deepseek-chat/spine/facts/session'
import type { EventLog } from '@deepseek-chat/spine/runtime'
import {
  DEFAULT_PYTHON_PARAMS,
  createKernel,
  spawnPyodideWorker,
  type NativePythonHost,
  type NativeRuntimeStatus,
  type PythonParams,
  type PythonRunResult,
  type RunOptions,
  type WorkerLike,
} from './kernel.js'
import { PYTHON_TOOL_NAME, buildPythonTool, type PythonToolDefinition } from './tool.js'

export type {
  NativePythonHost,
  NativeRunResponse,
  NativeRuntimeStatus,
  PresentedFile,
  PythonParams,
  PythonPhase,
  PythonRunResult,
  PythonUpload,
  RunOptions,
  WorkerLike,
} from './kernel.js'
export type { PythonToolDefinition } from './tool.js'

export type PythonSliceDeps = {
  readonly log: EventLog
  /** Desktop sandbox host; `null` selects the in-browser Pyodide engine. */
  readonly native: NativePythonHost | null
  /** Web engine: base URL Pyodide loads from. */
  readonly pyodideIndexURL: string
  /** Web engine: starts the Pyodide worker. Defaults to the bundled worker. */
  readonly spawnWorker?: () => WorkerLike
  readonly now?: () => number
  readonly params?: Partial<PythonParams>
}

export type PythonSlice = {
  readonly toolName: typeof PYTHON_TOOL_NAME
  readonly tool: PythonToolDefinition
  /** Runs code in the shared kernel. Always resolves; see SPEC.md. */
  run(code: string, options: RunOptions): Promise<PythonRunResult>
  /** Desktop only: the managed Python install. `null` on web. */
  readonly runtime: {
    status(): Promise<NativeRuntimeStatus>
    /** Reinstalls the runtime, then silently resets the kernel. */
    reset(): Promise<void>
  } | null
  dispose(): void
}

export const createPythonSlice = (deps: PythonSliceDeps): PythonSlice => {
  const { log, native } = deps
  const kernel = createKernel({
    native,
    pyodideIndexURL: deps.pyodideIndexURL,
    spawnWorker: deps.spawnWorker ?? spawnPyodideWorker,
    now: deps.now ?? (() => Date.now()),
    params: { ...DEFAULT_PYTHON_PARAMS, ...deps.params },
  })

  const unsubscribers = [
    log.subscribe<SessionDeleted>('SessionDeleted', ({ fact }) => {
      if (kernel.ownerSessionId() === fact.sessionId) {
        kernel.reset(false)
      }
    }),
    log.subscribe<SessionHistoryReplaced>('SessionHistoryReplaced', () => {
      kernel.reset(false)
    }),
  ]

  return {
    toolName: PYTHON_TOOL_NAME,
    tool: buildPythonTool(native ? 'native' : 'web'),
    run: kernel.run,
    runtime: native
      ? {
          status: () => native.runtimeStatus(),
          reset: async () => {
            await native.resetRuntime()
            kernel.reset(false)
          },
        }
      : null,
    dispose: () => {
      for (const unsubscribe of unsubscribers) {
        unsubscribe()
      }
    },
  }
}

// 开发时本 slice 变更不做热替换：旧 Worker 与旧工具说明会留在页面里，直接整页刷新。
// 不能写成 import.meta.webpackHot?.decline()：生产构建会把整个表达式替换成 (void 0)() 并在启动时抛错。
const hot = (import.meta as { webpackHot?: { decline: () => void } }).webpackHot
if (hot) {
  hot.decline()
}
