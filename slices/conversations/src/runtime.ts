import type { ModelProvider } from '@deepseek-chat/lib-agent'
import { createToolRegistry, type ToolRegistry } from '@deepseek-chat/lib-tools'
import type { BrowserControlTakenOver } from '@deepseek-chat/spine/facts/browser'
import type {
  ActiveSessionChanged,
  SessionDeleted,
  SessionFilesChanged,
  SessionHistoryReplaced,
} from '@deepseek-chat/spine/facts/session'
import { createLocaleStore, type Locale, type LocaleStore } from '@deepseek-chat/spine/i18n'
import {
  noopNoticePort,
  type BlobEntry,
  type BlobStore,
  type KeyValueStore,
  type NoticePort,
  type PanelSlot,
} from '@deepseek-chat/spine/ports'
import type { EventLog } from '@deepseek-chat/spine/runtime'
import { useMemo } from 'react'
import { create } from 'zustand'
import {
  createActivityInspectorCell,
  type ActivityInspectorCell,
  type SessionTurnSummary,
  type TurnSnapshot,
} from '../cells/activity-inspector/index.js'
import {
  estimateMessagesTokens,
  estimateSessionContext,
  runCompaction,
} from '../cells/compaction/index.js'
import {
  createIndexedDbSessionStore,
  reportStorageError,
  type SessionStore,
} from '../cells/storage/index.js'
import {
  SYSTEM_PROMPT,
  createAutoTitleRunner,
  createDraftsController,
  createReplyRunner,
  createUploadsController,
  localizeProvider,
  type ReplyRunnerParams,
  type StreamTrace,
} from '../cells/turn-loop/index.js'
import {
  createReadingPositions,
  type ConversationsViewDeps,
  type ConversationsViewRuntime,
} from '../cells/views/index.js'
import {
  INITIAL_CONVERSATIONS_STATE,
  appendBranch,
  canContinueReply,
  canResumeToolLoop,
  computeCompactionPolicy,
  createId,
  excerptOfPrompt,
  extractVisibleFileDescriptors,
  findActiveCheckpoint,
  getCachedSession,
  getContextRounds,
  getVisibleMessages,
  hasTurnActivity,
  isHistoryReady,
  isHistoryReplacing,
  isSessionBusy,
  isSessionDeleting,
  isSessionOrAllIdle,
  isSessionStreaming,
  lazyTranslate,
  normalizeSession,
  prepareDraftMessage,
  reduceConversations,
  sameSummary,
  selectVersion,
  settleReply,
  toHistoryPrefixMessages,
  trimAfterLastToolResult,
  type AssistantMessage,
  type CompactionCheckpoint,
  type ConversationsKernelAction,
  type ConversationsKernelState,
  type InlineAttachmentData,
  type LinkedMessage,
  type Message,
  type Session,
  type UserMessage,
} from '../kernel/index.js'

export type ConversationsParams = ReplyRunnerParams

export const DEFAULT_CONVERSATIONS_PARAMS: ConversationsParams = {
  maxParallelReadCalls: 6,
  toolRoundLimit: 50,
  networkRetryLimit: 2,
  fileReuploadLimit: 2,
  retryBaseDelayMs: 1000,
}

export type ConversationsDeps = {
  readonly log: EventLog
  /** Instance-scoped live UI locale store (defaults to an isolated local store). */
  readonly locale?: LocaleStore
  /** Provider-neutral model transport (streaming messages + optional file upload port). */
  readonly provider: ModelProvider
  /** Persists the `chat-demo:thinking` toggle owned by this slice. */
  readonly store: KeyValueStore
  /** Domain-blind blob store for user uploads and delivered files. */
  readonly blobs: BlobStore
  /** Optional session persistence store; defaults to IndexedDB `deepseek-sessions`. */
  readonly sessions?: SessionStore
  /** Aggregated capability registry (defaults to an empty registry for bare chat). */
  readonly tools?: ToolRegistry
  /** Optional right-hand panel slot hosting the built-in Activity & Sources inspector cell. */
  readonly activityPanel?: PanelSlot
  readonly platform?: 'desktop' | 'web'
  readonly getLocationLabel: (locale: Locale) => string
  readonly onStreamTrace?: (trace: StreamTrace) => void
  readonly autoTitle?: boolean
  readonly params?: Partial<ConversationsParams>
  readonly notify?: NoticePort
  readonly newId?: () => string
  readonly ui: ConversationsViewDeps
}

const THINKING_TOGGLE_KEY = 'chat-demo:thinking'
const SESSION_CACHE_LIMIT = 5
const NO_MESSAGES: readonly Message[] = []
const NO_CHECKPOINTS: readonly CompactionCheckpoint[] = []
const NO_TURNS: readonly SessionTurnSummary[] = []

const blobToBase64 = async (blob: Blob): Promise<string> => {
  const bytes = new Uint8Array(await blob.arrayBuffer())
  let binary = ''
  const chunkSize = 0x8000
  for (let offset = 0; offset < bytes.length; offset += chunkSize) {
    binary += String.fromCharCode(...bytes.subarray(offset, offset + chunkSize))
  }
  return btoa(binary)
}

export const createConversationsRuntime = (deps: ConversationsDeps) => {
  const localeStore = deps.locale ?? createLocaleStore()
  const tools = deps.tools ?? createToolRegistry([])
  const sessionStore = deps.sessions ?? createIndexedDbSessionStore()
  const ownsSessionStore = deps.sessions === undefined
  const platform = deps.platform ?? 'web'
  const newId = deps.newId ?? createId
  const notify = deps.notify ?? noopNoticePort
  const params: ConversationsParams = { ...DEFAULT_CONVERSATIONS_PARAMS, ...deps.params }

  const provider = localizeProvider(deps.provider)
  const uploads = createUploadsController(provider)
  const drafts = createDraftsController(uploads, newId)
  const reading = createReadingPositions()

  const useThinkingStore = create<{ thinking: boolean }>(() => ({
    thinking: deps.store.get(THINKING_TOGGLE_KEY) === 'true',
  }))
  const setThinking = (thinking: boolean) => {
    deps.store.set(THINKING_TOGGLE_KEY, String(thinking))
    useThinkingStore.setState({ thinking })
  }

  const useMobileSider = create<{ open: boolean }>(() => ({ open: false }))
  const openMobileSider = () => useMobileSider.setState({ open: true })
  const closeMobileSider = () => useMobileSider.setState({ open: false })

  const useChatStore = create<ConversationsKernelState>(() => INITIAL_CONVERSATIONS_STATE)
  const { getState: get, setState } = useChatStore
  const dispatch = (action: ConversationsKernelAction) => {
    setState((prev) => reduceConversations(prev, action))
  }

  const showNotice = (notice: LinkedMessage) => {
    const { key, params: msgParams, type, link } = notice
    notify.show({
      text: lazyTranslate(key, msgParams),
      ...(type === 'error' ? { tone: 'error' as const } : {}),
      ...(link ? { link: { text: lazyTranslate(link.key), href: link.href } } : {}),
    })
  }

  const ensureApiKey = () => {
    if (provider.isConfigured()) {
      return true
    }
    deps.ui.openSettings('apiKey')
    return false
  }

  // Non-serializable live runtime handles (never stored in Zustand state).
  const streamControllers = new Map<string, AbortController>()
  const manualCompactions = new Map<string, AbortController>()
  const streamFlushes = new Map<string, () => void>()
  const pendingBlobs = new Map<string, BlobEntry[]>()
  const deletionTasks = new Set<Promise<boolean>>()
  const publishedFileSessions = new Set<string>()
  const turnListeners = new Set<() => void>()
  const sessionLoads = new Map<string, { promise: Promise<void> }>()
  let initTask: Promise<void> | undefined
  let lastPublishedActiveId: string | null | undefined

  const notifyTurnListeners = () => {
    for (const listener of [...turnListeners]) {
      listener()
    }
  }

  const publishActiveSession = (sessionId: string | null) => {
    if (lastPublishedActiveId === sessionId) {
      return
    }
    lastPublishedActiveId = sessionId
    deps.log.publishSticky<ActiveSessionChanged>('unit', {
      type: 'ActiveSessionChanged',
      sessionId,
    })
  }

  const getSession = (id: string) => getCachedSession(get(), id)

  const setCompacting = (sessionId: string, active: boolean) => {
    dispatch({ type: 'setCompacting', id: sessionId, active })
    notifyTurnListeners()
  }

  const updateSession = (id: string, update: (session: Session) => Session) => {
    let changed = false
    setState((state) => {
      const previous = getCachedSession(state, id)
      if (!previous) {
        return state
      }
      const nextSession = update(previous)
      if (nextSession === previous) {
        return state
      }
      changed = true
      return reduceConversations(state, { type: 'updateSession', id, session: nextSession })
    })
    if (changed) {
      notifyTurnListeners()
    }
  }

  const updateReply = (sessionId: string, reply: AssistantMessage) =>
    updateSession(sessionId, (session) => ({
      ...session,
      messages: session.messages.map((message) =>
        message.id === reply.id
          ? { ...reply, parentId: message.parentId, selectedChildId: message.selectedChildId }
          : message
      ),
    }))

  const appendCheckpoint = (sessionId: string, checkpoint: CompactionCheckpoint) => {
    updateSession(sessionId, (session) => ({
      ...session,
      checkpoints: [...(session.checkpoints ?? []), checkpoint],
    }))
    persist(sessionId)
  }

  const publishSessionFiles = (sessionId: string) => {
    const session = getSession(sessionId)
    if (!session) {
      return
    }
    publishedFileSessions.add(sessionId)
    deps.log.publishSticky<SessionFilesChanged>(sessionId, {
      type: 'SessionFilesChanged',
      sessionId,
      files: extractVisibleFileDescriptors(session),
    })
  }

  const persist = (sessionId: string) => {
    const session = getSession(sessionId)
    if (!session) {
      return
    }
    dispatch({ type: 'markUnsaved', id: sessionId })
    if (isSessionDeleting(get(), sessionId)) {
      return
    }
    const epoch = get().historyEpoch
    const blobsToWrite = pendingBlobs.get(sessionId)
    void (async () => {
      try {
        if (blobsToWrite && blobsToWrite.length > 0) {
          await deps.blobs.put(blobsToWrite)
        }
        await sessionStore.saveSession(session)
        if (epoch !== get().historyEpoch || !getSession(sessionId)) {
          return
        }
        if (pendingBlobs.get(sessionId) === blobsToWrite) {
          pendingBlobs.delete(sessionId)
        }
        if (getSession(sessionId) === session) {
          dispatch({ type: 'markSaved', id: sessionId, savedSession: session })
          dispatch({ type: 'trimCache', limit: SESSION_CACHE_LIMIT })
        }
      } catch (error) {
        reportStorageError('save session')(error)
        if (epoch === get().historyEpoch && getSession(sessionId)) {
          dispatch({ type: 'markSaveError', id: sessionId })
        }
      }
    })()
  }

  const retrySaveSessions = () => {
    const state = get()
    if (!isHistoryReplacing(state)) {
      for (const id of Object.keys(state.unsavedIds)) {
        persist(id)
      }
    }
  }

  const bindChatPersistence = () => {
    const save = () => {
      const state = get()
      if (isHistoryReplacing(state)) {
        return
      }
      for (const [id, flush] of streamFlushes) {
        flush()
        persist(id)
      }
      for (const id of Object.keys(state.unsavedIds)) {
        if (!streamFlushes.has(id)) {
          persist(id)
        }
      }
    }
    const onVisibilityChange = () => {
      if (document.visibilityState === 'hidden') {
        save()
      }
    }
    document.addEventListener('visibilitychange', onVisibilityChange)
    window.addEventListener('pagehide', save)
    return () => {
      document.removeEventListener('visibilitychange', onVisibilityChange)
      window.removeEventListener('pagehide', save)
    }
  }

  const readBlob = async (id: string): Promise<Blob | undefined> => {
    for (const entries of pendingBlobs.values()) {
      const hit = entries.find((entry) => entry.id === id)
      if (hit) {
        return hit.blob
      }
    }
    return deps.blobs.get(id)
  }

  const autoTitleRunner = createAutoTitleRunner({
    enabled: deps.autoTitle !== false,
    provider,
    getHistoryEpoch: () => get().historyEpoch,
    isImportingHistory: () => isHistoryReplacing(get()),
    isDeletingSession: (id) => isSessionDeleting(get(), id),
    getSession,
    updateSession,
    persist,
  })

  const replyRunner = createReplyRunner({
    log: deps.log,
    getLocale: localeStore.get,
    readBlob,
    tools,
    provider,
    uploads,
    compaction: {
      estimateMessagesTokens,
      estimateSessionContext,
      runCompaction,
    },
    platform,
    params,
    getLocationLabel: deps.getLocationLabel,
    onStreamTrace: deps.onStreamTrace,
    newId,
    session: {
      getHistoryEpoch: () => get().historyEpoch,
      isImportingHistory: () => isHistoryReplacing(get()),
      getActiveSessionId: () => get().activeId,
      get: getSession,
      update: updateSession,
      updateReply,
      persist,
      publishFiles: publishSessionFiles,
      setStreaming: (sessionId, controller) => {
        if (controller) {
          streamControllers.set(sessionId, controller)
          dispatch({ type: 'setStreaming', id: sessionId, active: true })
        } else {
          streamControllers.delete(sessionId)
          dispatch({ type: 'setStreaming', id: sessionId, active: false })
        }
        notifyTurnListeners()
      },
      setCompacting,
      appendCheckpoint,
      notifyCompactionNotice: (key) => showNotice({ key }),
      registerFlush: (sessionId, flush) => {
        if (flush) {
          streamFlushes.set(sessionId, flush)
        } else {
          streamFlushes.delete(sessionId)
        }
      },
      onAutoTitle: (autoParams) => autoTitleRunner.run(autoParams),
    },
  })

  const createReply = (): AssistantMessage => ({
    id: newId(),
    role: 'assistant',
    createdAt: Date.now(),
    model: provider.defaultModel,
    provider: provider.id,
    thinking: useThinkingStore.getState().thinking,
    enabledCapabilities: tools.snapshotEnabled(),
    status: 'pending',
    blocks: [],
  })

  const settleInterrupted = (session: Session): Session => {
    let changed = false
    const messages = session.messages.map((message) => {
      if (message.role !== 'assistant') {
        return message
      }
      let nextMessage = message
      if (message.capabilityState && tools.turnHooks.length > 0) {
        let nextCapState: Record<string, unknown> | null = null
        for (const { capabilityId, hooks } of tools.turnHooks) {
          if (!hooks.onReplyHydrated || !Object.hasOwn(message.capabilityState, capabilityId)) {
            continue
          }
          const prevVal = message.capabilityState[capabilityId]
          const hydratedVal = hooks.onReplyHydrated(prevVal)
          if (hydratedVal !== prevVal) {
            nextCapState ??= { ...message.capabilityState }
            nextCapState[capabilityId] = hydratedVal
          }
        }
        if (nextCapState) {
          nextMessage = { ...nextMessage, capabilityState: nextCapState }
          changed = true
        }
      }
      if (nextMessage.status === 'pending' || nextMessage.status === 'streaming') {
        nextMessage = settleReply(nextMessage, 'stopped', session.updatedAt)
        changed = true
      }
      return nextMessage
    })
    return changed ? { ...session, messages } : session
  }

  const initChat = (): Promise<void> => {
    if (isHistoryReady(get())) {
      return Promise.resolve()
    }
    if (initTask) {
      return initTask
    }
    const epoch = get().historyEpoch
    dispatch({ type: 'initStart' })
    initTask = (async () => {
      try {
        const summaries = await sessionStore.loadSummaries()
        if (epoch === get().historyEpoch) {
          dispatch({ type: 'initSucceeded', summaries })
          publishActiveSession(get().activeId)
        }
      } catch (error) {
        if (epoch === get().historyEpoch) {
          dispatch({ type: 'initFailed' })
          reportStorageError('read local sessions')(error)
        }
      } finally {
        if (epoch === get().historyEpoch) {
          initTask = undefined
        }
      }
    })()
    return initTask
  }

  const ensureSessionLoaded = (id: string): Promise<void> => {
    if (getSession(id)) {
      publishSessionFiles(id)
      return Promise.resolve()
    }
    const pending = sessionLoads.get(id)
    if (pending) {
      return pending.promise
    }
    const epoch = get().historyEpoch
    dispatch({ type: 'setLoadError', id, failed: false })
    const load = { promise: Promise.resolve() }
    sessionLoads.set(id, load)
    load.promise = (async () => {
      try {
        const stored = await sessionStore.loadSession(id)
        if (epoch !== get().historyEpoch || sessionLoads.get(id) !== load) {
          return
        }
        const summary = get().sessions.find((session) => session.id === id)
        if (!summary) {
          return
        }
        if (!stored) {
          throw new Error(`Session ${id} is missing from local storage`)
        }
        const settled = settleInterrupted(normalizeSession(stored))
        const session = sameSummary(settled, summary) ? settled : { ...settled, ...summary }
        dispatch({ type: 'cacheLoadedSession', session })
        notifyTurnListeners()
        publishSessionFiles(id)
        if (session !== stored) {
          persist(id)
        }
        dispatch({ type: 'trimCache', limit: SESSION_CACHE_LIMIT })
      } catch (error) {
        if (epoch === get().historyEpoch && sessionLoads.get(id) === load) {
          dispatch({ type: 'setLoadError', id, failed: true })
          reportStorageError('read session')(error)
        }
      } finally {
        if (sessionLoads.get(id) === load) {
          sessionLoads.delete(id)
        }
      }
    })()
    return load.promise
  }

  const waitForIdle = (sessionId?: string) =>
    new Promise<void>((resolve) => {
      if (isSessionOrAllIdle(get(), sessionId)) {
        resolve()
        return
      }
      const unsubscribe = useChatStore.subscribe((state) => {
        if (isSessionOrAllIdle(state, sessionId)) {
          unsubscribe()
          resolve()
        }
      })
    })

  const replaceSessions = async (
    prepare: () => Promise<{
      readonly sessions: readonly Session[]
      readonly blobs: readonly BlobEntry[]
    }>
  ): Promise<number> => {
    if (isHistoryReplacing(get())) {
      throw new Error('History replacement is already in progress')
    }
    dispatch({ type: 'beginHistoryReplace' })
    try {
      autoTitleRunner.cancel()
      for (const controller of streamControllers.values()) {
        controller.abort()
      }
      for (const controller of manualCompactions.values()) {
        controller.abort()
      }
      await Promise.all(deletionTasks)
      dispatch({ type: 'bumpHistoryEpoch' })
      initTask = undefined
      sessionLoads.clear()
      await waitForIdle()

      const { sessions: nextSessions, blobs: nextBlobs } = await prepare()
      await deps.blobs.replaceAll(nextBlobs)
      const summaries = await sessionStore.replaceAll(nextSessions)

      for (const id of publishedFileSessions) {
        deps.log.tombstone('SessionFilesChanged', id)
      }
      publishedFileSessions.clear()
      deps.log.publish<SessionHistoryReplaced>({ type: 'SessionHistoryReplaced' })
      reading.clear()
      pendingBlobs.clear()
      drafts.clearAllDrafts()
      dispatch({ type: 'commitHistoryReplace', summaries })
      publishActiveSession(null)
      notifyTurnListeners()
      return summaries.length
    } finally {
      dispatch({ type: 'finishHistoryReplace' })
      retrySaveSessions()
      const latest = get()
      if (latest.activeId !== null) {
        void ensureSessionLoaded(latest.activeId)
      } else if (!isHistoryReady(latest)) {
        void initChat()
      }
    }
  }

  const snapshotForExport = () => {
    const { sessions, sessionCache } = get()
    return {
      summaries: [...sessions],
      loadSession: async (id: string): Promise<Session | undefined> =>
        Object.hasOwn(sessionCache, id) ? sessionCache[id] : sessionStore.loadSession(id),
    }
  }

  const newChat = () => {
    if (!isHistoryReplacing(get())) {
      dispatch({ type: 'setActiveSession', id: null })
      publishActiveSession(null)
      dispatch({ type: 'trimCache', limit: SESSION_CACHE_LIMIT })
    }
  }

  const selectSession = (id: string) => {
    const state = get()
    if (!isHistoryReplacing(state) && state.sessions.some((session) => session.id === id)) {
      dispatch({ type: 'setActiveSession', id })
      publishActiveSession(id)
      void ensureSessionLoaded(id)
      dispatch({ type: 'trimCache', limit: SESSION_CACHE_LIMIT })
    }
  }

  const renameSession = (id: string, title: string) => {
    const state = get()
    if (isHistoryReplacing(state) || isSessionDeleting(state, id)) {
      return
    }
    autoTitleRunner.cancel(id)
    const titleLocked = title.trim().length > 0
    if (getSession(id)) {
      updateSession(id, (session) => ({ ...session, title, titleLocked }))
      persist(id)
    } else {
      dispatch({ type: 'renameUnloadedSession', id, title })
      void sessionStore
        .renameSession(id, title, titleLocked)
        .catch(reportStorageError('rename session'))
    }
  }

  const removeSessionData = async (id: string): Promise<boolean> => {
    const state = get()
    if (
      isHistoryReplacing(state) ||
      isSessionDeleting(state, id) ||
      !state.sessions.some((session) => session.id === id)
    ) {
      return false
    }
    const epoch = state.historyEpoch
    dispatch({ type: 'setDeleting', id, deleting: true })
    try {
      autoTitleRunner.cancel(id)
      streamControllers.get(id)?.abort()
      manualCompactions.get(id)?.abort()
      await waitForIdle(id)
      if (epoch !== get().historyEpoch) {
        return false
      }
      const orphanedBlobs = await sessionStore.deleteSession(id)
      if (orphanedBlobs.length > 0) {
        await deps.blobs.delete(orphanedBlobs).catch(reportStorageError('delete orphaned blobs'))
      }
      if (publishedFileSessions.delete(id)) {
        deps.log.tombstone('SessionFilesChanged', id)
      }
      deps.log.publish<SessionDeleted>({ type: 'SessionDeleted', sessionId: id })
      reading.forget(id)
      if (epoch !== get().historyEpoch) {
        return true
      }
      sessionLoads.delete(id)
      pendingBlobs.delete(id)
      drafts.clearDraft(id)
      const wasActive = get().activeId === id
      dispatch({ type: 'removeSession', id })
      if (wasActive) {
        publishActiveSession(null)
      }
      notifyTurnListeners()
      return true
    } catch (error) {
      reportStorageError('delete session')(error)
      return false
    } finally {
      dispatch({ type: 'setDeleting', id, deleting: false })
      if (getSession(id)) {
        if (isHistoryReplacing(get())) {
          dispatch({ type: 'markUnsaved', id })
        } else {
          persist(id)
        }
      }
    }
  }

  const removeSession = (id: string): Promise<boolean> => {
    const task = removeSessionData(id).finally(() => deletionTasks.delete(task))
    deletionTasks.add(task)
    return task
  }

  const stopReply = (sessionId: string) => {
    streamControllers.get(sessionId)?.abort()
    manualCompactions.get(sessionId)?.abort()
  }

  const compactSession = async (
    sessionId: string
  ): Promise<'compacted' | 'notNeeded' | 'cancelled' | 'failed'> => {
    const state = get()
    if (
      isHistoryReplacing(state) ||
      isSessionDeleting(state, sessionId) ||
      isSessionBusy(state, sessionId) ||
      manualCompactions.has(sessionId)
    ) {
      return 'failed'
    }
    const session = getSession(sessionId)
    if (!session) {
      return 'failed'
    }
    const visible = getVisibleMessages(session)
    if (getContextRounds(visible).length === 0) {
      showNotice({ key: 'compactionNoticeNothingToCompact' })
      return 'notNeeded'
    }
    if (!ensureApiKey()) {
      return 'failed'
    }

    const epoch = get().historyEpoch
    const controller = new AbortController()
    manualCompactions.set(sessionId, controller)
    setCompacting(sessionId, true)
    try {
      let inlineBlobs: Map<string, InlineAttachmentData> | undefined
      if (!provider.attachments) {
        inlineBlobs = new Map()
        for (const [user] of getContextRounds(visible)) {
          for (const file of user.files) {
            if (inlineBlobs.has(file.id)) {
              continue
            }
            if (controller.signal.aborted) {
              return 'cancelled'
            }
            const blob = await readBlob(file.id)
            if (!blob) {
              continue
            }
            inlineBlobs.set(file.id, {
              mediaType: file.mimeType || blob.type || 'application/octet-stream',
              base64: await blobToBase64(blob),
            })
          }
        }
      }

      const model = provider.defaultModel
      const modelSpec = provider.modelSpec(model)
      const policy = computeCompactionPolicy(modelSpec)
      const enabledCapabilities = tools.snapshotEnabled()
      const declaredTools = tools.declare({ questionText: '', enabledCapabilities })
      const declaredClientNames = new Set(declaredTools.map((tool) => tool.name))
      const system = [SYSTEM_PROMPT, ...tools.instructions(declaredClientNames, 'reply')].join(
        '\n\n'
      )
      const priorCheckpoint = findActiveCheckpoint(visible, session.checkpoints)
      const prefixMessages = toHistoryPrefixMessages(visible, {
        checkpoint: priorCheckpoint ?? undefined,
        clientTools: declaredClientNames,
        providerId: provider.id,
        inlineBlobs,
      })
      const systemOverheadTokens = estimateMessagesTokens([], system, declaredTools)
      const wireEstimate = estimateMessagesTokens(prefixMessages, system, declaredTools)
      const sessionEstimate = estimateSessionContext({
        visibleMessages: visible,
        checkpoints: session.checkpoints,
        modelSpec,
        systemOverheadTokens,
      })
      const tokensBefore = Math.max(wireEstimate, sessionEstimate.tokens)

      const result = await runCompaction({
        provider,
        toolRegistry: tools,
        trigger: 'manual',
        model,
        system,
        tools: declaredTools,
        history: visible,
        priorCheckpoint: priorCheckpoint ?? undefined,
        declaredClientNames,
        providerId: provider.id,
        inlineBlobs,
        inlineToolImages: !provider.attachments,
        includeInProgressThinking: false,
        tokensBefore,
        policy,
        signal: controller.signal,
        newId,
      })

      if (epoch !== get().historyEpoch || isSessionDeleting(get(), sessionId)) {
        return 'cancelled'
      }
      if (result.kind === 'compacted') {
        appendCheckpoint(sessionId, result.checkpoint)
        return 'compacted'
      }
      if (result.kind === 'notNeeded') {
        showNotice({ key: 'compactionNoticeNothingToCompact' })
        return 'notNeeded'
      }
      if (result.kind === 'cancelled') {
        return 'cancelled'
      }
      showNotice({ key: 'compactionNoticeManualFailed', type: 'error' })
      return 'failed'
    } finally {
      if (manualCompactions.get(sessionId) === controller) {
        manualCompactions.delete(sessionId)
      }
      setCompacting(sessionId, false)
    }
  }

  const sendMessage = (targetSessionId: string | null) => {
    const state = get()
    if (isHistoryReplacing(state) || !isHistoryReady(state)) {
      return false
    }
    const prepared = prepareDraftMessage(drafts.getDraft(targetSessionId), uploads.getTasks())
    if (!prepared) {
      return false
    }
    const { text, files } = prepared
    const now = Date.now()
    let sessionId = targetSessionId
    if (
      sessionId !== null &&
      (isSessionDeleting(state, sessionId) ||
        isSessionBusy(state, sessionId) ||
        !getSession(sessionId))
    ) {
      return false
    }
    if (sessionId === null) {
      const session: Session = {
        id: newId(),
        title: '',
        createdAt: now,
        updatedAt: now,
        messages: [],
        rootMessageId: null,
      }
      sessionId = session.id
      dispatch({ type: 'createSession', session })
      publishActiveSession(session.id)
    }
    const current = getSession(sessionId)
    if (!current) {
      return false
    }
    const history = getVisibleMessages(current)
    const question: UserMessage = {
      id: newId(),
      role: 'user',
      content: text,
      files: files.map(({ id, serverId, serverProvider, name, size, isImage, mimeType }) => ({
        id,
        serverId,
        ...(serverProvider ? { serverProvider } : {}),
        name,
        size,
        isImage,
        mimeType,
      })),
      createdAt: now,
    }
    const reply = createReply()
    updateSession(sessionId, (session) => ({
      ...appendBranch(session, history.at(-1)?.id ?? null, [question, reply]),
      updatedAt: now,
    }))
    if (files.length > 0) {
      pendingBlobs.set(sessionId, [
        ...(pendingBlobs.get(sessionId) ?? []),
        ...files.map(({ id, blob }) => ({ id, blob })),
      ])
    }
    publishSessionFiles(sessionId)
    persist(sessionId)
    drafts.clearSentDraft(targetSessionId)
    autoTitleRunner.cancel(sessionId)
    void replyRunner.streamReply(sessionId, reply, { history, question })
    return true
  }

  const regenerateReply = (sessionId: string, messageId?: string) => {
    const state = get()
    if (isHistoryReplacing(state) || isSessionDeleting(state, sessionId)) {
      return
    }
    const session = getSession(sessionId)
    if (!session || isSessionBusy(state, sessionId)) {
      return
    }
    const path = getVisibleMessages(session)
    const index =
      messageId === undefined ? path.length - 1 : path.findIndex((m) => m.id === messageId)
    const question = path[index - 1]
    if (question?.role !== 'user' || path[index]?.role !== 'assistant') {
      return
    }
    const history = path.slice(0, index - 1)
    const reply = createReply()
    updateSession(sessionId, (s) => ({
      ...appendBranch(s, question.id, [reply]),
      updatedAt: Date.now(),
    }))
    publishSessionFiles(sessionId)
    persist(sessionId)
    autoTitleRunner.cancel(sessionId)
    void replyRunner.streamReply(sessionId, reply, { history, question })
  }

  const editMessage = (sessionId: string, messageId: string, content: string): boolean => {
    const state = get()
    if (isHistoryReplacing(state) || isSessionDeleting(state, sessionId)) {
      return false
    }
    const session = getSession(sessionId)
    if (!session || isSessionBusy(state, sessionId)) {
      return false
    }
    const path = getVisibleMessages(session)
    const index = path.findIndex((message) => message.id === messageId)
    const previous = path[index]
    const text = content.trim()
    if (previous?.role !== 'user' || (!text && previous.files.length === 0)) {
      return false
    }
    const question: UserMessage = {
      id: newId(),
      role: 'user',
      content: text,
      files: previous.files,
      createdAt: Date.now(),
    }
    const reply = createReply()
    updateSession(sessionId, (s) => ({
      ...appendBranch(s, path[index - 1]?.id ?? null, [question, reply]),
      updatedAt: Date.now(),
    }))
    publishSessionFiles(sessionId)
    persist(sessionId)
    autoTitleRunner.cancel(sessionId)
    void replyRunner.streamReply(sessionId, reply, { history: path.slice(0, index), question })
    return true
  }

  const selectMessageVersion = (sessionId: string, messageId: string) => {
    const state = get()
    if (
      isHistoryReplacing(state) ||
      isSessionDeleting(state, sessionId) ||
      isSessionBusy(state, sessionId)
    ) {
      return
    }
    autoTitleRunner.cancel(sessionId)
    updateSession(sessionId, (session) => selectVersion(session, messageId))
    publishSessionFiles(sessionId)
    persist(sessionId)
  }

  const continueReply = (sessionId: string, messageId: string) => {
    const state = get()
    if (isHistoryReplacing(state) || isSessionDeleting(state, sessionId)) {
      return
    }
    const session = getSession(sessionId)
    if (!session || isSessionBusy(state, sessionId)) {
      return
    }
    const path = getVisibleMessages(session)
    const question = path.at(-2)
    const previous = path.at(-1)
    if (
      question?.role !== 'user' ||
      previous?.role !== 'assistant' ||
      previous.id !== messageId ||
      !canContinueReply(previous)
    ) {
      return
    }
    const resume = canResumeToolLoop(previous)
    const base = resume ? trimAfterLastToolResult(previous) : previous
    const reply: AssistantMessage = {
      ...base,
      model: previous.model ?? provider.defaultModel,
      provider: previous.provider ?? provider.id,
      thinking: previous.thinking ?? useThinkingStore.getState().thinking,
      enabledCapabilities: previous.enabledCapabilities ?? tools.snapshotEnabled(),
      status: 'pending',
      stopReason: undefined,
      stopDetails: undefined,
      error: undefined,
    }
    updateReply(sessionId, reply)
    updateSession(sessionId, (s) => ({ ...s, updatedAt: Date.now() }))
    persist(sessionId)
    autoTitleRunner.cancel(sessionId)
    void replyRunner.streamReply(sessionId, reply, {
      history: path.slice(0, -2),
      question,
      continueReply: resume ? undefined : previous,
    })
  }

  const retryUpload = (sessionId: string, messageId: string) => {
    const state = get()
    if (isHistoryReplacing(state) || isSessionDeleting(state, sessionId)) {
      return
    }
    const session = getSession(sessionId)
    if (!session || isSessionBusy(state, sessionId)) {
      return
    }
    const path = getVisibleMessages(session)
    const index = path.findIndex((message) => message.id === messageId)
    const question = path[index - 1]
    const previous = path[index]
    if (
      question?.role !== 'user' ||
      previous?.role !== 'assistant' ||
      previous.error?.kind !== 'upload'
    ) {
      return
    }
    const reply: AssistantMessage = { ...previous, status: 'pending', error: undefined }
    updateReply(sessionId, reply)
    persist(sessionId)
    autoTitleRunner.cancel(sessionId)
    void replyRunner.streamReply(sessionId, reply, { history: path.slice(0, index - 1), question })
  }

  const getChatMessages = (sessionId: string): readonly Message[] => {
    const session = getSession(sessionId)
    return session ? getVisibleMessages(session) : NO_MESSAGES
  }

  const getChatCheckpoints = (sessionId: string): readonly CompactionCheckpoint[] => {
    const session = getSession(sessionId)
    return session?.checkpoints ?? NO_CHECKPOINTS
  }

  const useChatMessages = (sessionId: string | null): readonly Message[] => {
    const session = useChatStore((state) => getCachedSession(state, sessionId))
    return useMemo(() => (session ? getVisibleMessages(session) : NO_MESSAGES), [session])
  }

  const useHistoryState = () => ({
    replacing: useChatStore(isHistoryReplacing),
    empty: useChatStore((state) => state.sessions.length === 0),
  })

  const turnSnapshotCache = new WeakMap<AssistantMessage, TurnSnapshot>()
  const sessionTurnsCache = new WeakMap<
    Session,
    { readonly isStreaming: boolean; readonly list: readonly SessionTurnSummary[] }
  >()

  const listSessionTurns = (sessionId: string): readonly SessionTurnSummary[] => {
    const state = get()
    const session = getCachedSession(state, sessionId)
    if (!session) {
      return NO_TURNS
    }
    const isStreaming = isSessionStreaming(state, sessionId)
    const cached = sessionTurnsCache.get(session)
    if (cached && cached.isStreaming === isStreaming) {
      return cached.list
    }
    const visible = getVisibleMessages(session)
    const turns: SessionTurnSummary[] = []
    let lastUserPrompt = ''
    let turnNumber = 0
    for (const msg of visible) {
      if (msg.role === 'user') {
        lastUserPrompt = excerptOfPrompt(msg.content)
        continue
      }
      turnNumber += 1
      turns.push({
        messageId: msg.id,
        turnNumber,
        promptExcerpt: lastUserPrompt,
        streaming: isStreaming && msg.status === 'streaming',
        hasActivity: hasTurnActivity(msg),
      })
    }
    sessionTurnsCache.set(session, { isStreaming, list: turns })
    return turns
  }

  const getTurnSnapshot = (sessionId: string, messageId: string): TurnSnapshot | null => {
    const state = get()
    const session = getCachedSession(state, sessionId)
    const found = session?.messages.find((item) => item.id === messageId)
    if (!found || found.role !== 'assistant') {
      return null
    }
    const streaming = isSessionStreaming(state, sessionId) && found.status === 'streaming'
    const cached = turnSnapshotCache.get(found)
    if (
      cached &&
      cached.sessionId === sessionId &&
      cached.messageId === found.id &&
      cached.status === found.status &&
      cached.blocks === found.blocks &&
      cached.streaming === streaming &&
      cached.capabilityState === found.capabilityState
    ) {
      return cached
    }
    const snapshot: TurnSnapshot = {
      sessionId,
      messageId: found.id,
      status: found.status,
      blocks: found.blocks,
      streaming,
      capabilityState: found.capabilityState,
    }
    turnSnapshotCache.set(found, snapshot)
    return snapshot
  }

  const subscribeToTurns = (listener: () => void) => {
    turnListeners.add(listener)
    return () => {
      turnListeners.delete(listener)
    }
  }

  const activity: ActivityInspectorCell | null = deps.activityPanel
    ? createActivityInspectorCell({
        log: deps.log,
        panel: deps.activityPanel,
        turnSource: {
          getTurn: getTurnSnapshot,
          listTurns: listSessionTurns,
          subscribe: subscribeToTurns,
        },
        transcript: reading,
        getPresenter: tools.presenterFor,
        openInApp: deps.ui.openInApp,
        ...(deps.ui.openFile
          ? {
              openFile: (sessionId, file) =>
                deps.ui.openFile?.(sessionId, { kind: 'delivered', file }),
            }
          : {}),
      })
    : null

  const requestTurnInspection = (
    sessionId: string,
    messageId: string,
    tab: 'activity' | 'sources',
    callId?: string
  ) => {
    activity?.toggleTurn(sessionId, messageId, tab, callId)
  }

  const unsubscribers = [
    deps.log.subscribe<BrowserControlTakenOver>('BrowserControlTakenOver', ({ fact }) => {
      stopReply(fact.sessionId)
    }),
  ]

  const dispose = () => {
    activity?.dispose()
    autoTitleRunner.cancel()
    for (const controller of streamControllers.values()) {
      controller.abort()
    }
    streamControllers.clear()
    for (const controller of manualCompactions.values()) {
      controller.abort()
    }
    manualCompactions.clear()
    for (const unsubscribe of unsubscribers) {
      unsubscribe()
    }
    drafts.clearAllDrafts()
    uploads.dispose()
    turnListeners.clear()
    if (ownsSessionStore) {
      sessionStore.close?.()
    }
  }

  const viewRuntime: ConversationsViewRuntime = {
    deps,
    tools,
    blobs: deps.blobs,
    provider,
    uploads,
    drafts,
    useChatState: useChatStore,
    getChatState: get,
    subscribeChatState: useChatStore.subscribe,
    useThinking: useThinkingStore,
    setThinking,
    useMobileSider,
    openMobileSider,
    closeMobileSider,
    showNotice,
    ensureApiKey,
    bindChatPersistence,
    retrySaveSessions,
    initChat,
    newChat,
    selectSession,
    renameSession,
    removeSession,
    sendMessage,
    regenerateReply,
    editMessage,
    selectMessageVersion,
    continueReply,
    retryUpload,
    stopReply,
    compactSession,
    requestTurnInspection,
    activity,
    reading,
  }

  return {
    ...viewRuntime,
    getLocale: localeStore.get,
    useChatStore,
    useThinkingStore,
    waitForIdle,
    replaceSessions,
    snapshotForExport,
    getChatMessages,
    getChatCheckpoints,
    useChatMessages,
    useHistoryState,
    getTurnSnapshot,
    activity,
    dispose,
  }
}

export type ConversationsRuntime = ReturnType<typeof createConversationsRuntime>
