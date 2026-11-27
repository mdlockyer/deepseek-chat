import type { ModelProvider } from '@deepseek-chat/lib-agent'
import { createToolRegistry, type ToolRegistry } from '@deepseek-chat/lib-tools'
import type { BrowserControlTakenOver } from '@deepseek-chat/spine/facts/browser'
import type {
  ActiveSessionChanged,
  SessionDeleted,
  SessionFileDescriptor,
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
import { localizeProvider } from './apiClient.js'
import { createUploadsController } from './attachments.js'
import { createAutoTitleRunner } from './autoTitleRunner.js'
import { appendBranch, getVisibleMessages, normalizeSession, selectVersion } from './branches.js'
import { computeCompactionPolicy } from './compaction/budget.js'
import { runCompaction } from './compaction/compact.js'
import { estimateMessagesTokens, estimateSessionContext } from './compaction/estimate.js'
import { createDraftsController, prepareDraftMessage } from './drafts.js'
import { createId } from './id.js'
import { lazyTranslate, type LinkedMessage } from './messages.js'
import {
  canContinueReply,
  canResumeToolLoop,
  findActiveCheckpoint,
  getContextRounds,
  settleReply,
  toHistoryPrefixMessages,
  trimAfterLastToolResult,
  type InlineAttachmentData,
} from './reply.js'
import { createReadingPositions } from './reading.js'
import { SYSTEM_PROMPT, createReplyRunner, type ReplyRunnerParams } from './replyRunner.js'
import {
  createIndexedDbSessionStore,
  reportStorageError,
  type SessionStore,
} from './sessionStore.js'
import type { StreamTrace } from './streamTrace.js'
import { excerptOfPrompt, hasTurnActivity } from './turns.js'
import {
  toSessionSummary,
  type AssistantMessage,
  type CompactionCheckpoint,
  type Message,
  type Session,
  type SessionSummary,
  type UserMessage,
} from './types.js'
import type { ConversationsViewDeps } from './views.js'

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

type ChatState = {
  ready: boolean
  initError: boolean
  importingHistory: boolean
  sessions: SessionSummary[]
  sessionCache: Record<string, Session>
  sessionLoadErrors: Record<string, boolean>
  sessionSaveErrors: Record<string, boolean>
  activeId: string | null
  streaming: Record<string, AbortController>
  compacting: Record<string, boolean>
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

const sortSessions = (sessions: SessionSummary[]) =>
  [...sessions].sort((a, b) => b.updatedAt - a.updatedAt)

const sameSummary = (a: SessionSummary, b: SessionSummary) =>
  a.title === b.title && a.createdAt === b.createdAt && a.updatedAt === b.updatedAt

const extractVisibleFileDescriptors = (session: Session): SessionFileDescriptor[] => {
  const descriptors: SessionFileDescriptor[] = []
  for (const message of getVisibleMessages(session)) {
    if (message.role === 'user') {
      for (const file of message.files) {
        descriptors.push({
          kind: 'upload',
          fileId: file.id,
          name: file.name,
          size: file.size,
          mimeType: file.mimeType,
          messageId: message.id,
          createdAt: message.createdAt,
        })
      }
      continue
    }
    const callById = new Map(
      message.blocks.flatMap((block) => (block.type === 'tool_use' ? [[block.id, block]] : []))
    )
    for (const block of message.blocks) {
      if (block.type !== 'tool_result' || !block.files?.length) {
        continue
      }
      const call = callById.get(block.tool_use_id)
      for (const file of block.files) {
        descriptors.push({
          kind: 'delivered',
          fileId: file.id,
          name: file.name,
          size: file.size,
          mimeType: file.mimeType,
          ...(file.path ? { path: file.path } : {}),
          ...(file.title ? { title: file.title } : {}),
          ...(file.version !== undefined ? { version: file.version } : {}),
          ...((file.producer ?? block.capability)
            ? { producer: file.producer ?? block.capability }
            : {}),
          ...(call ? { producedByTool: call.name } : {}),
          messageId: message.id,
          createdAt: message.createdAt,
        })
      }
    }
  }
  return descriptors
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

  const useThinkingStore = create<{ thinking: boolean }>(() => ({
    thinking: deps.store.get(THINKING_TOGGLE_KEY) === 'true',
  }))
  const setThinking = (thinking: boolean) => {
    deps.store.set(THINKING_TOGGLE_KEY, String(thinking))
    useThinkingStore.setState({ thinking })
  }

  const reading = createReadingPositions()

  const useMobileSider = create<{ open: boolean }>(() => ({ open: false }))
  const openMobileSider = () => useMobileSider.setState({ open: true })
  const closeMobileSider = () => useMobileSider.setState({ open: false })

  const useChatStore = create<ChatState>(() => ({
    ready: false,
    initError: false,
    importingHistory: false,
    sessions: [],
    sessionCache: {},
    sessionLoadErrors: {},
    sessionSaveErrors: {},
    activeId: null,
    streaming: {},
    compacting: {},
  }))
  const { getState: get, setState: set } = useChatStore

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

  const sessionAccess = new Map<string, number>()
  const unsavedSessions = new Set<string>()
  const pendingBlobs = new Map<string, BlobEntry[]>()
  const deletingSessions = new Set<string>()
  const deletionTasks = new Set<Promise<boolean>>()
  const streamFlushes = new Map<string, () => void>()
  const manualCompactions = new Map<string, AbortController>()
  const publishedFileSessions = new Set<string>()
  const turnListeners = new Set<() => void>()
  const sessionLoads = new Map<string, { promise: Promise<void> }>()
  let accessSequence = 0
  let historyEpoch = 0
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

  const getSession = (id: string) => {
    const cache = get().sessionCache
    return Object.hasOwn(cache, id) ? cache[id] : undefined
  }

  const getStreamController = (id: string) => {
    const streams = get().streaming
    return Object.hasOwn(streams, id) ? streams[id] : undefined
  }

  const isSessionBusy = (id: string) =>
    Boolean(getStreamController(id)) || manualCompactions.has(id) || get().compacting[id] === true

  const setCompacting = (sessionId: string, active: boolean) => {
    set((state) => {
      const current = state.compacting[sessionId] === true
      if (current === active) {
        return state
      }
      return {
        compacting: active
          ? { ...state.compacting, [sessionId]: true }
          : Object.fromEntries(Object.entries(state.compacting).filter(([id]) => id !== sessionId)),
      }
    })
    notifyTurnListeners()
  }

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

  const touchSession = (id: string) => sessionAccess.set(id, ++accessSequence)

  const trimSessionCache = () => {
    const state = get()
    const ids = Object.keys(state.sessionCache)
    if (ids.length <= SESSION_CACHE_LIMIT) {
      return
    }
    const removable = ids
      .filter(
        (id) =>
          id !== state.activeId &&
          !Object.hasOwn(state.streaming, id) &&
          state.compacting[id] !== true &&
          !unsavedSessions.has(id) &&
          !deletingSessions.has(id)
      )
      .sort((a, b) => (sessionAccess.get(a) ?? 0) - (sessionAccess.get(b) ?? 0))
    const evicted = new Set(removable.slice(0, ids.length - SESSION_CACHE_LIMIT))
    for (const id of evicted) {
      sessionAccess.delete(id)
    }
    if (evicted.size > 0) {
      set({
        sessionCache: Object.fromEntries(
          Object.entries(state.sessionCache).filter(([id]) => !evicted.has(id))
        ),
      })
    }
  }

  const updateSession = (id: string, update: (session: Session) => Session) => {
    let changed = false
    set((state) => {
      const previous = Object.hasOwn(state.sessionCache, id) ? state.sessionCache[id] : undefined
      if (!previous) {
        return state
      }
      const session = update(previous)
      if (session === previous) {
        return state
      }
      changed = true
      return {
        sessionCache: { ...state.sessionCache, [id]: session },
        sessions: sameSummary(previous, session)
          ? state.sessions
          : sortSessions(
              state.sessions.map((summary) =>
                summary.id === id ? toSessionSummary(session) : summary
              )
            ),
      }
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

  const persist = (sessionId: string) => {
    const session = getSession(sessionId)
    if (!session) {
      return
    }
    unsavedSessions.add(sessionId)
    if (deletingSessions.has(sessionId)) {
      return
    }
    const epoch = historyEpoch
    const blobsToWrite = pendingBlobs.get(sessionId)
    void (async () => {
      try {
        if (blobsToWrite && blobsToWrite.length > 0) {
          await deps.blobs.put(blobsToWrite)
        }
        await sessionStore.saveSession(session)
        if (epoch !== historyEpoch || !getSession(sessionId)) {
          return
        }
        if (pendingBlobs.get(sessionId) === blobsToWrite) {
          pendingBlobs.delete(sessionId)
        }
        if (getSession(sessionId) === session) {
          unsavedSessions.delete(sessionId)
          set((state) => ({
            sessionSaveErrors: Object.fromEntries(
              Object.entries(state.sessionSaveErrors).filter(([id]) => id !== sessionId)
            ),
          }))
          trimSessionCache()
        }
      } catch (error) {
        reportStorageError('save session')(error)
        if (epoch === historyEpoch && getSession(sessionId)) {
          set((state) => ({
            sessionSaveErrors: { ...state.sessionSaveErrors, [sessionId]: true },
          }))
        }
      }
    })()
  }

  const retrySaveSessions = () => {
    if (!get().importingHistory) {
      unsavedSessions.forEach(persist)
    }
  }

  const bindChatPersistence = () => {
    const save = () => {
      if (get().importingHistory) {
        return
      }
      for (const [id, flush] of streamFlushes) {
        flush()
        persist(id)
      }
      for (const id of unsavedSessions) {
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
    getHistoryEpoch: () => historyEpoch,
    isImportingHistory: () => get().importingHistory,
    isDeletingSession: (id) => deletingSessions.has(id),
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
    platform,
    params,
    getLocationLabel: deps.getLocationLabel,
    onStreamTrace: deps.onStreamTrace,
    getHistoryEpoch: () => historyEpoch,
    isImportingHistory: () => get().importingHistory,
    getActiveSessionId: () => get().activeId,
    getSession,
    updateSession,
    updateReply,
    persist,
    publishSessionFiles,
    setStreaming: (sessionId, controller) => {
      set((state) => ({
        streaming: controller
          ? { ...state.streaming, [sessionId]: controller }
          : Object.fromEntries(Object.entries(state.streaming).filter(([id]) => id !== sessionId)),
      }))
      notifyTurnListeners()
    },
    setCompacting,
    appendCheckpoint,
    notifyCompactionNotice: (key) => showNotice({ key }),
    newId,
    registerFlush: (sessionId, flush) => {
      if (flush) {
        streamFlushes.set(sessionId, flush)
      } else {
        streamFlushes.delete(sessionId)
      }
    },
    onAutoTitle: (autoParams) => autoTitleRunner.run(autoParams),
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
    if (get().ready) {
      return Promise.resolve()
    }
    if (initTask) {
      return initTask
    }
    const epoch = historyEpoch
    set({ initError: false })
    initTask = (async () => {
      try {
        const summaries = await sessionStore.loadSummaries()
        if (epoch === historyEpoch) {
          set({ ready: true, sessions: sortSessions(summaries) })
          publishActiveSession(get().activeId)
        }
      } catch (error) {
        if (epoch === historyEpoch) {
          set({ initError: true })
          reportStorageError('read local sessions')(error)
        }
      } finally {
        if (epoch === historyEpoch) {
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
    const epoch = historyEpoch
    set((state) => ({ sessionLoadErrors: { ...state.sessionLoadErrors, [id]: false } }))
    const load = { promise: Promise.resolve() }
    sessionLoads.set(id, load)
    load.promise = (async () => {
      try {
        const stored = await sessionStore.loadSession(id)
        if (epoch !== historyEpoch || sessionLoads.get(id) !== load) {
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
        touchSession(id)
        set((state) => ({ sessionCache: { ...state.sessionCache, [id]: session } }))
        notifyTurnListeners()
        publishSessionFiles(id)
        if (session !== stored) {
          persist(id)
        }
        trimSessionCache()
      } catch (error) {
        if (epoch === historyEpoch && sessionLoads.get(id) === load) {
          set((state) => ({ sessionLoadErrors: { ...state.sessionLoadErrors, [id]: true } }))
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
      const isIdle = (state: ChatState) =>
        sessionId === undefined
          ? Object.keys(state.streaming).length === 0 && Object.keys(state.compacting).length === 0
          : !Object.hasOwn(state.streaming, sessionId) && state.compacting[sessionId] !== true
      if (isIdle(get())) {
        resolve()
        return
      }
      const unsubscribe = useChatStore.subscribe((state) => {
        if (isIdle(state)) {
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
    if (get().importingHistory) {
      throw new Error('History replacement is already in progress')
    }
    set({ importingHistory: true })
    try {
      autoTitleRunner.cancel()
      for (const controller of Object.values(get().streaming)) {
        controller.abort()
      }
      for (const controller of manualCompactions.values()) {
        controller.abort()
      }
      await Promise.all(deletionTasks)
      historyEpoch += 1
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
      sessionAccess.clear()
      unsavedSessions.clear()
      pendingBlobs.clear()
      drafts.clearAllDrafts()
      set({
        ready: true,
        initError: false,
        sessions: sortSessions(summaries),
        sessionCache: {},
        sessionLoadErrors: {},
        sessionSaveErrors: {},
        activeId: null,
      })
      publishActiveSession(null)
      notifyTurnListeners()
      return summaries.length
    } finally {
      set({ importingHistory: false })
      retrySaveSessions()
      const { activeId, ready } = get()
      if (activeId !== null) {
        void ensureSessionLoaded(activeId)
      } else if (!ready) {
        void initChat()
      }
    }
  }

  const snapshotForExport = () => {
    const { sessions, sessionCache } = get()
    return {
      summaries: sessions,
      loadSession: async (id: string): Promise<Session | undefined> =>
        Object.hasOwn(sessionCache, id) ? sessionCache[id] : sessionStore.loadSession(id),
    }
  }

  const newChat = () => {
    if (!get().importingHistory) {
      set({ activeId: null })
      publishActiveSession(null)
      trimSessionCache()
    }
  }

  const selectSession = (id: string) => {
    if (!get().importingHistory && get().sessions.some((session) => session.id === id)) {
      touchSession(id)
      set({ activeId: id })
      publishActiveSession(id)
      void ensureSessionLoaded(id)
      trimSessionCache()
    }
  }

  const renameSession = (id: string, title: string) => {
    if (get().importingHistory || deletingSessions.has(id)) {
      return
    }
    autoTitleRunner.cancel(id)
    const titleLocked = title.trim().length > 0
    if (getSession(id)) {
      updateSession(id, (session) => ({ ...session, title, titleLocked }))
      persist(id)
    } else {
      set((state) => ({
        sessions: state.sessions.map((session) =>
          session.id === id ? { ...session, title } : session
        ),
      }))
      void sessionStore
        .renameSession(id, title, titleLocked)
        .catch(reportStorageError('rename session'))
    }
  }

  const removeSessionData = async (id: string): Promise<boolean> => {
    if (
      get().importingHistory ||
      deletingSessions.has(id) ||
      !get().sessions.some((session) => session.id === id)
    ) {
      return false
    }
    const epoch = historyEpoch
    deletingSessions.add(id)
    try {
      autoTitleRunner.cancel(id)
      getStreamController(id)?.abort()
      manualCompactions.get(id)?.abort()
      await waitForIdle(id)
      if (epoch !== historyEpoch) {
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
      if (epoch !== historyEpoch) {
        return true
      }
      sessionLoads.delete(id)
      sessionAccess.delete(id)
      unsavedSessions.delete(id)
      pendingBlobs.delete(id)
      drafts.clearDraft(id)
      const wasActive = get().activeId === id
      set((state) => ({
        sessions: state.sessions.filter((session) => session.id !== id),
        sessionCache: Object.fromEntries(
          Object.entries(state.sessionCache).filter(([key]) => key !== id)
        ),
        sessionLoadErrors: Object.fromEntries(
          Object.entries(state.sessionLoadErrors).filter(([key]) => key !== id)
        ),
        sessionSaveErrors: Object.fromEntries(
          Object.entries(state.sessionSaveErrors).filter(([key]) => key !== id)
        ),
        activeId: state.activeId === id ? null : state.activeId,
      }))
      if (wasActive) {
        publishActiveSession(null)
      }
      notifyTurnListeners()
      return true
    } catch (error) {
      reportStorageError('delete session')(error)
      return false
    } finally {
      deletingSessions.delete(id)
      if (getSession(id)) {
        if (get().importingHistory) {
          unsavedSessions.add(id)
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
    getStreamController(sessionId)?.abort()
    manualCompactions.get(sessionId)?.abort()
  }

  const compactSession = async (
    sessionId: string
  ): Promise<'compacted' | 'notNeeded' | 'cancelled' | 'failed'> => {
    if (get().importingHistory || deletingSessions.has(sessionId) || isSessionBusy(sessionId)) {
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

    const epoch = historyEpoch
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

      if (epoch !== historyEpoch || deletingSessions.has(sessionId)) {
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
    if (get().importingHistory || !get().ready) {
      return false
    }
    const prepared = prepareDraftMessage(
      drafts.getDraft(targetSessionId),
      uploads.useUploads.getState().tasks
    )
    if (!prepared) {
      return false
    }
    const { text, files } = prepared
    const now = Date.now()
    let sessionId = targetSessionId
    if (
      sessionId !== null &&
      (deletingSessions.has(sessionId) || isSessionBusy(sessionId) || !getSession(sessionId))
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
      touchSession(session.id)
      set((state) => ({
        sessions: [toSessionSummary(session), ...state.sessions],
        sessionCache: { ...state.sessionCache, [session.id]: session },
        activeId: session.id,
      }))
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
    if (get().importingHistory || deletingSessions.has(sessionId)) {
      return
    }
    const session = getSession(sessionId)
    if (!session || isSessionBusy(sessionId)) {
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
    if (get().importingHistory || deletingSessions.has(sessionId)) {
      return false
    }
    const session = getSession(sessionId)
    if (!session || isSessionBusy(sessionId)) {
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
    if (get().importingHistory || deletingSessions.has(sessionId) || isSessionBusy(sessionId)) {
      return
    }
    autoTitleRunner.cancel(sessionId)
    updateSession(sessionId, (session) => selectVersion(session, messageId))
    publishSessionFiles(sessionId)
    persist(sessionId)
  }

  const continueReply = (sessionId: string, messageId: string) => {
    if (get().importingHistory || deletingSessions.has(sessionId)) {
      return
    }
    const session = getSession(sessionId)
    if (!session || isSessionBusy(sessionId)) {
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
    if (get().importingHistory || deletingSessions.has(sessionId)) {
      return
    }
    const session = getSession(sessionId)
    if (!session || isSessionBusy(sessionId)) {
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
    const session = useChatStore((state) =>
      sessionId && Object.hasOwn(state.sessionCache, sessionId)
        ? state.sessionCache[sessionId]
        : undefined
    )
    return useMemo(() => (session ? getVisibleMessages(session) : NO_MESSAGES), [session])
  }

  const useHistoryState = () => ({
    replacing: useChatStore((state) => state.importingHistory),
    empty: useChatStore((state) => state.sessions.length === 0),
  })

  const turnSnapshotCache = new WeakMap<AssistantMessage, TurnSnapshot>()
  const sessionTurnsCache = new WeakMap<
    Session,
    { readonly isStreaming: boolean; readonly list: readonly SessionTurnSummary[] }
  >()

  const listSessionTurns = (sessionId: string): readonly SessionTurnSummary[] => {
    const state = get()
    const session = Object.hasOwn(state.sessionCache, sessionId)
      ? state.sessionCache[sessionId]
      : undefined
    if (!session) {
      return NO_TURNS
    }
    const isStreaming = Object.hasOwn(state.streaming, sessionId)
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
    const session = Object.hasOwn(state.sessionCache, sessionId)
      ? state.sessionCache[sessionId]
      : undefined
    const found = session?.messages.find((item) => item.id === messageId)
    if (!found || found.role !== 'assistant') {
      return null
    }
    const streaming = Object.hasOwn(state.streaming, sessionId) && found.status === 'streaming'
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
    for (const controller of Object.values(get().streaming)) {
      controller.abort()
    }
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

  return {
    deps,
    getLocale: localeStore.get,
    tools,
    blobs: deps.blobs,
    provider,
    uploads,
    drafts,
    useChatStore,
    useThinkingStore,
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
    waitForIdle,
    replaceSessions,
    snapshotForExport,
    getChatMessages,
    getChatCheckpoints,
    useChatMessages,
    useHistoryState,
    getTurnSnapshot,
    requestTurnInspection,
    activity,
    reading,
    dispose,
  }
}

export type ConversationsRuntime = ReturnType<typeof createConversationsRuntime>
