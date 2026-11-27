import type {
  ActivityStepEntry,
  CompactionLedgerSection,
  DeliveredFileRef,
  ToolCapability,
} from '@deepseek-chat/lib-tools'
import { IconCodeOutline14 } from '@deepseek-chat/lib-ui'
import type {
  SessionDeleted,
  SessionFileDescriptor,
  SessionFilesChanged,
  SessionHistoryReplaced,
} from '@deepseek-chat/spine/facts/session'
import type { BlobStore, KeyValueStore } from '@deepseek-chat/spine/ports'
import type { EventLog } from '@deepseek-chat/spine/runtime'
import { createElement, type ReactElement } from 'react'
import {
  DEFAULT_PYTHON_PARAMS,
  createKernel,
  spawnPyodideWorker,
  type NativePythonHost,
  type NativeRuntimeStatus,
  type PythonParams,
  type PythonRunResult,
  type PythonUpload,
  type RunOptions,
  type WorkerLike,
} from './kernel.js'
import { pythonMessages } from './messages.js'
import { pythonPresenter, serializePythonForArchive } from './presenter.js'
import { createRuntimeSetting } from './RuntimeSetting.js'
import {
  PYTHON_TOOL_NAME,
  buildPythonInstructions,
  buildPythonTool,
  type PythonToolDefinition,
} from './tool.js'

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

const PYTHON_TOGGLE_KEY = 'chat-demo:python'

const normalizePath = (raw: string): string =>
  raw
    .trim()
    .replace(/\\/g, '/')
    .split('/')
    .filter((seg) => seg !== '' && seg !== '.' && seg !== '..')
    .join('/')

/** Collects user uploads plus latest non-Python delivered files for Python's read-only `uploads/`. */
const buildSessionUploads = (
  files: readonly SessionFileDescriptor[],
  loadBlob: (id: string) => Promise<Blob | undefined>
): PythonUpload[] => {
  const seenIds = new Set<string>()
  const uploads: PythonUpload[] = []
  for (const file of files) {
    if (file.kind === 'upload' && !seenIds.has(file.fileId)) {
      seenIds.add(file.fileId)
      uploads.push({ id: file.fileId, name: file.name, loadBlob: () => loadBlob(file.fileId) })
    }
  }
  const latestByPath = new Map<string, SessionFileDescriptor>()
  const pathOrder: string[] = []
  for (const file of files) {
    if (file.kind !== 'delivered') {
      continue
    }
    const key = normalizePath(file.path ?? file.name) || file.name
    if (!latestByPath.has(key)) {
      pathOrder.push(key)
    }
    latestByPath.set(key, file)
  }
  for (const key of pathOrder) {
    const latest = latestByPath.get(key)
    if (
      !latest ||
      latest.producer === 'python' ||
      latest.producedByTool === PYTHON_TOOL_NAME ||
      seenIds.has(latest.fileId)
    ) {
      continue
    }
    seenIds.add(latest.fileId)
    uploads.push({
      id: latest.fileId,
      name: latest.name,
      loadBlob: () => loadBlob(latest.fileId),
    })
  }
  return uploads
}

export type PythonSliceDeps = {
  readonly log: EventLog
  /** Desktop sandbox host; `null` selects the in-browser Pyodide engine. */
  readonly native: NativePythonHost | null
  /** Web engine: base URL Pyodide loads from. */
  readonly pyodideIndexURL: string
  /** Key-value store persisting the `chat-demo:python` composer toggle. */
  readonly store: KeyValueStore
  /** Optional blob store for mounting session uploads and persisting generated files. */
  readonly blobs?: BlobStore
  /** Web engine: starts the Pyodide worker. Defaults to the bundled worker. */
  readonly spawnWorker?: () => WorkerLike
  readonly now?: () => number
  readonly newId?: () => string
  readonly params?: Partial<PythonParams>
}

export type PythonSlice = {
  readonly toolName: typeof PYTHON_TOOL_NAME
  readonly tool: PythonToolDefinition
  readonly instructions: string
  readonly capability: ToolCapability
  /** Runs code in the shared kernel. Always resolves; see SPEC.md. */
  run(code: string, options: RunOptions): Promise<PythonRunResult>
  /** Desktop only: the managed Python install. `null` on web. */
  readonly runtime: {
    status(): Promise<NativeRuntimeStatus>
    /** Reinstalls the runtime, then silently resets the kernel. */
    reset(): Promise<void>
  } | null
  /** Settings row for the desktop runtime; renders nothing on web. */
  RuntimeSetting(): ReactElement | null
  dispose(): void
}

export const createPythonSlice = (deps: PythonSliceDeps): PythonSlice => {
  const { log, native, store } = deps
  const blobs = deps.blobs
  const newId = deps.newId ?? (() => crypto.randomUUID())

  let enabled = store.get(PYTHON_TOGGLE_KEY) === 'true'
  const toggleListeners = new Set<() => void>()
  const setEnabled = (next: boolean) => {
    if (enabled === next) {
      return
    }
    enabled = next
    store.set(PYTHON_TOGGLE_KEY, String(next))
    for (const listener of [...toggleListeners]) {
      listener()
    }
  }

  const filesBySession = new Map<string, readonly SessionFileDescriptor[]>()

  const kernel = createKernel({
    native,
    pyodideIndexURL: deps.pyodideIndexURL,
    spawnWorker: deps.spawnWorker ?? spawnPyodideWorker,
    now: deps.now ?? (() => Date.now()),
    params: { ...DEFAULT_PYTHON_PARAMS, ...deps.params },
  })

  const unsubscribers = [
    log.subscribe<SessionFilesChanged>(
      'SessionFilesChanged',
      ({ fact }) => {
        filesBySession.set(fact.sessionId, fact.files)
      },
      { replaySticky: true }
    ),
    log.subscribe<SessionDeleted>('SessionDeleted', ({ fact }) => {
      filesBySession.delete(fact.sessionId)
      if (kernel.ownerSessionId() === fact.sessionId) {
        kernel.reset(false)
      }
    }),
    log.subscribe<SessionHistoryReplaced>('SessionHistoryReplaced', () => {
      filesBySession.clear()
      kernel.reset(false)
    }),
  ]

  const runtime = native
    ? {
        status: () => native.runtimeStatus(),
        reset: async () => {
          await native.resetRuntime()
          kernel.reset(false)
        },
      }
    : null

  const engine = native ? 'native' : 'web'
  const tool = buildPythonTool(engine)
  const instructions = buildPythonInstructions(engine)

  const capability: ToolCapability = {
    id: 'python',
    toggle: {
      id: 'python',
      label: pythonMessages.lazy('pythonToggleLabel'),
      icon: createElement(IconCodeOutline14),
      isEnabled: () => enabled,
      setEnabled,
      subscribe: (listener) => {
        toggleListeners.add(listener)
        return () => {
          toggleListeners.delete(listener)
        }
      },
    },
    initialProgress: () => ({ phase: 'starting' }),
    declareTools: ({ enabledCapabilities }) => (enabledCapabilities.python ? [tool] : []),
    instructions: (names, audience) =>
      audience === 'reply' && names.has(PYTHON_TOOL_NAME) ? instructions : null,
    describe: (name, audience) => (audience === 'reply' && name === PYTHON_TOOL_NAME ? tool : null),
    handles: (name) => name === PYTHON_TOOL_NAME,
    effectOf: () => 'session',
    run: async (call, ctx) => {
      const code =
        call.input && typeof (call.input as { code?: unknown }).code === 'string'
          ? (call.input as { code: string }).code
          : null
      if (code === null) {
        return {
          content: `Invalid input: expected {"code": string}, got ${ctx.inputJson ?? call.inputJson ?? JSON.stringify(call.input)}`,
          status: 'error',
          images: [],
          durationMs: 0,
        }
      }
      const sessionFiles = filesBySession.get(ctx.sessionId) ?? []
      const uploads = blobs
        ? buildSessionUploads(sessionFiles, (id) => blobs.get(id))
        : buildSessionUploads(sessionFiles, async () => undefined)
      const outcome = await kernel.run(code, {
        signal: ctx.signal,
        sessionId: ctx.sessionId,
        uploads,
        onPhase: (phase) => ctx.onProgress({ phase }),
      })
      let text = outcome.text
      let delivered: DeliveredFileRef[] | undefined
      if (outcome.files.length > 0) {
        const stored = outcome.files.map((file) => ({
          id: newId(),
          blob: new Blob([file.data as Uint8Array<ArrayBuffer>], { type: file.mimeType }),
          file,
        }))
        let saved = true
        if (blobs) {
          try {
            await blobs.put(stored.map(({ id, blob }) => ({ id, blob })))
          } catch {
            saved = false
            text += '\n[Saving the files in the browser failed, so the user cannot download them.]'
          }
        }
        if (saved) {
          delivered = stored.map(({ id, file }) => ({
            id,
            name: file.name,
            path: normalizePath(file.name) || file.name,
            size: file.data.byteLength,
            mimeType: file.mimeType,
            producer: 'python',
          }))
        }
      }
      return {
        content: text,
        status: outcome.status,
        images: outcome.images,
        durationMs: outcome.durationMs,
        ...(delivered ? { files: delivered } : {}),
      }
    },
    presenter: pythonPresenter,
    serializeForArchive: serializePythonForArchive,
    buildCompactionLedger: (
      entries: readonly ActivityStepEntry[]
    ): CompactionLedgerSection | null => {
      const files = new Map<string, { path: string; mimeType: string }>()
      let okCount = 0
      let unresolvedError: string | null = null
      for (const { result } of entries) {
        if (!result || result.status === 'running') {
          continue
        }
        if (result.status === 'ok') {
          okCount += 1
          unresolvedError = null
          for (const file of result.files ?? []) {
            const path = file.path ?? file.name
            files.set(normalizePath(path) || path, { path, mimeType: file.mimeType })
          }
        } else if (result.status === 'error') {
          unresolvedError = result.content.split('\n')[0]?.trim().slice(0, 160) || 'execution error'
        }
      }
      const lines: string[] = []
      for (const file of files.values()) {
        lines.push(`- \`${file.path}\` (${file.mimeType}): generated by Python`)
      }
      if (okCount > 0) {
        lines.push(
          `- Completed Python runs: ${okCount} (in-memory session variables persist until reset).`
        )
      }
      if (unresolvedError) {
        lines.push(`- Latest Python run failed: ${unresolvedError}`)
      }
      return lines.length > 0 ? { title: 'Python sandbox', lines } : null
    },
  }

  return {
    toolName: PYTHON_TOOL_NAME,
    tool,
    instructions,
    capability,
    run: kernel.run,
    runtime,
    RuntimeSetting: createRuntimeSetting(runtime),
    dispose: () => {
      filesBySession.clear()
      toggleListeners.clear()
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
