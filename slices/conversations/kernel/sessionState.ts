import type { SessionFileDescriptor } from '@deepseek-chat/spine/facts/session'
import { getVisibleMessages } from './branches.js'
import { toSessionSummary, type Session, type SessionSummary } from './types.js'

export type HistoryPhase =
  | { readonly kind: 'loading' }
  | { readonly kind: 'initError' }
  | { readonly kind: 'ready' }
  | { readonly kind: 'replacing'; readonly prior: 'loading' | 'initError' | 'ready' }

export type SessionActivity =
  | { readonly kind: 'idle' }
  | { readonly kind: 'streaming'; readonly compacting: boolean }
  | { readonly kind: 'compacting' }

export type ConversationsKernelState = {
  readonly phase: HistoryPhase
  readonly historyEpoch: number
  readonly sessions: readonly SessionSummary[]
  readonly sessionCache: Readonly<Record<string, Session>>
  readonly activeId: string | null
  readonly activity: Readonly<Record<string, SessionActivity>>
  readonly deletingIds: Readonly<Record<string, true>>
  readonly unsavedIds: Readonly<Record<string, true>>
  readonly loadErrors: Readonly<Record<string, true>>
  readonly saveErrors: Readonly<Record<string, true>>
  readonly accessOrder: Readonly<Record<string, number>>
  readonly accessSequence: number
}

export const INITIAL_CONVERSATIONS_STATE: ConversationsKernelState = {
  phase: { kind: 'loading' },
  historyEpoch: 0,
  sessions: [],
  sessionCache: {},
  activeId: null,
  activity: {},
  deletingIds: {},
  unsavedIds: {},
  loadErrors: {},
  saveErrors: {},
  accessOrder: {},
  accessSequence: 0,
}

export const sortSessions = (sessions: readonly SessionSummary[]): SessionSummary[] =>
  [...sessions].sort((a, b) => b.updatedAt - a.updatedAt)

export const sameSummary = (a: SessionSummary, b: SessionSummary): boolean =>
  a.title === b.title && a.createdAt === b.createdAt && a.updatedAt === b.updatedAt

export const isHistoryReady = (state: Pick<ConversationsKernelState, 'phase'>): boolean =>
  state.phase.kind === 'ready' ||
  (state.phase.kind === 'replacing' && state.phase.prior === 'ready')

export const isHistoryReplacing = (state: Pick<ConversationsKernelState, 'phase'>): boolean =>
  state.phase.kind === 'replacing'

export const hasInitError = (state: Pick<ConversationsKernelState, 'phase'>): boolean =>
  state.phase.kind === 'initError' ||
  (state.phase.kind === 'replacing' && state.phase.prior === 'initError')

export const getCachedSession = (
  state: Pick<ConversationsKernelState, 'sessionCache'>,
  sessionId: string | null | undefined
): Session | undefined =>
  sessionId && Object.hasOwn(state.sessionCache, sessionId)
    ? state.sessionCache[sessionId]
    : undefined

export const isSessionStreaming = (
  state: Pick<ConversationsKernelState, 'activity'>,
  sessionId: string | null | undefined
): boolean => Boolean(sessionId && state.activity[sessionId]?.kind === 'streaming')

export const isSessionCompacting = (
  state: Pick<ConversationsKernelState, 'activity'>,
  sessionId: string | null | undefined
): boolean => {
  if (!sessionId || !Object.hasOwn(state.activity, sessionId)) {
    return false
  }
  const activity = state.activity[sessionId]
  return activity.kind === 'compacting' || (activity.kind === 'streaming' && activity.compacting)
}

export const isSessionDeleting = (
  state: Pick<ConversationsKernelState, 'deletingIds'>,
  sessionId: string | null | undefined
): boolean => Boolean(sessionId && state.deletingIds[sessionId] === true)

export const isSessionBusy = (
  state: Pick<ConversationsKernelState, 'activity'>,
  sessionId: string
): boolean => isSessionStreaming(state, sessionId) || isSessionCompacting(state, sessionId)

export const isSessionOrAllIdle = (
  state: Pick<ConversationsKernelState, 'activity'>,
  sessionId?: string
): boolean =>
  sessionId === undefined
    ? Object.keys(state.activity).length === 0
    : !isSessionBusy(state, sessionId)

export const replyingSessionIds = (state: Pick<ConversationsKernelState, 'activity'>): string[] =>
  Object.entries(state.activity)
    .filter(([, activity]) => activity.kind === 'streaming')
    .map(([id]) => id)

export const hasAnySaveError = (state: Pick<ConversationsKernelState, 'saveErrors'>): boolean =>
  Object.keys(state.saveErrors).length > 0

export const hasLoadError = (
  state: Pick<ConversationsKernelState, 'loadErrors'>,
  sessionId: string | null | undefined
): boolean => Boolean(sessionId && state.loadErrors[sessionId] === true)

/**
 * Selects cached session IDs eligible for LRU eviction above `limit`. Always pins the active
 * session plus any streaming, compacting, unsaved, or deleting session.
 */
export const selectLruEvictions = (
  state: Pick<
    ConversationsKernelState,
    'activeId' | 'sessionCache' | 'activity' | 'unsavedIds' | 'deletingIds' | 'accessOrder'
  >,
  limit: number
): readonly string[] => {
  const ids = Object.keys(state.sessionCache)
  if (ids.length <= limit) {
    return []
  }
  const removable = ids
    .filter(
      (id) =>
        id !== state.activeId &&
        !isSessionBusy(state, id) &&
        state.unsavedIds[id] !== true &&
        state.deletingIds[id] !== true
    )
    .sort((a, b) => (state.accessOrder[a] ?? 0) - (state.accessOrder[b] ?? 0))
  return removable.slice(0, ids.length - limit)
}

export const extractVisibleFileDescriptors = (session: Session): SessionFileDescriptor[] => {
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

export type ConversationsKernelAction =
  | { readonly type: 'initStart' }
  | { readonly type: 'initSucceeded'; readonly summaries: readonly SessionSummary[] }
  | { readonly type: 'initFailed' }
  | { readonly type: 'beginHistoryReplace' }
  | { readonly type: 'bumpHistoryEpoch' }
  | { readonly type: 'commitHistoryReplace'; readonly summaries: readonly SessionSummary[] }
  | { readonly type: 'finishHistoryReplace' }
  | { readonly type: 'setActiveSession'; readonly id: string | null }
  | { readonly type: 'setLoadError'; readonly id: string; readonly failed: boolean }
  | { readonly type: 'cacheLoadedSession'; readonly session: Session }
  | { readonly type: 'createSession'; readonly session: Session }
  | { readonly type: 'updateSession'; readonly id: string; readonly session: Session }
  | { readonly type: 'renameUnloadedSession'; readonly id: string; readonly title: string }
  | { readonly type: 'markUnsaved'; readonly id: string }
  | { readonly type: 'markSaved'; readonly id: string; readonly savedSession: Session }
  | { readonly type: 'markSaveError'; readonly id: string }
  | { readonly type: 'setStreaming'; readonly id: string; readonly active: boolean }
  | { readonly type: 'setCompacting'; readonly id: string; readonly active: boolean }
  | { readonly type: 'setDeleting'; readonly id: string; readonly deleting: boolean }
  | { readonly type: 'removeSession'; readonly id: string }
  | { readonly type: 'trimCache'; readonly limit: number }

const omitKey = <T>(record: Readonly<Record<string, T>>, key: string): Record<string, T> => {
  if (!Object.hasOwn(record, key)) {
    return record as Record<string, T>
  }
  return Object.fromEntries(Object.entries(record).filter(([k]) => k !== key))
}

const touchAccess = (state: ConversationsKernelState, id: string) => {
  const nextSeq = state.accessSequence + 1
  return {
    accessSequence: nextSeq,
    accessOrder: { ...state.accessOrder, [id]: nextSeq },
  }
}

export const reduceConversations = (
  state: ConversationsKernelState,
  action: ConversationsKernelAction
): ConversationsKernelState => {
  switch (action.type) {
    case 'initStart':
      if (state.phase.kind === 'replacing' || state.phase.kind === 'loading') {
        return state
      }
      return { ...state, phase: { kind: 'loading' } }

    case 'initSucceeded':
      return {
        ...state,
        phase:
          state.phase.kind === 'replacing'
            ? { kind: 'replacing', prior: 'ready' }
            : { kind: 'ready' },
        sessions: sortSessions(action.summaries),
      }

    case 'initFailed':
      return {
        ...state,
        phase:
          state.phase.kind === 'replacing'
            ? { kind: 'replacing', prior: 'initError' }
            : { kind: 'initError' },
      }

    case 'beginHistoryReplace': {
      const prior = state.phase.kind === 'replacing' ? state.phase.prior : state.phase.kind
      return { ...state, phase: { kind: 'replacing', prior } }
    }

    case 'bumpHistoryEpoch':
      return { ...state, historyEpoch: state.historyEpoch + 1 }

    case 'commitHistoryReplace':
      return {
        ...state,
        phase: { kind: 'replacing', prior: 'ready' },
        sessions: sortSessions(action.summaries),
        sessionCache: {},
        activeId: null,
        unsavedIds: {},
        loadErrors: {},
        saveErrors: {},
        accessOrder: {},
        accessSequence: 0,
      }

    case 'finishHistoryReplace':
      if (state.phase.kind !== 'replacing') {
        return state
      }
      return { ...state, phase: { kind: state.phase.prior } }

    case 'setActiveSession':
      if (action.id === null) {
        return state.activeId === null ? state : { ...state, activeId: null }
      }
      return {
        ...state,
        activeId: action.id,
        ...touchAccess(state, action.id),
      }

    case 'setLoadError': {
      const nextLoadErrors = action.failed
        ? { ...state.loadErrors, [action.id]: true as const }
        : omitKey(state.loadErrors, action.id)
      return nextLoadErrors === state.loadErrors ? state : { ...state, loadErrors: nextLoadErrors }
    }

    case 'cacheLoadedSession':
      return {
        ...state,
        ...touchAccess(state, action.session.id),
        sessionCache: { ...state.sessionCache, [action.session.id]: action.session },
        loadErrors: omitKey(state.loadErrors, action.session.id),
      }

    case 'createSession':
      return {
        ...state,
        ...touchAccess(state, action.session.id),
        sessions: [toSessionSummary(action.session), ...state.sessions],
        sessionCache: { ...state.sessionCache, [action.session.id]: action.session },
        activeId: action.session.id,
      }

    case 'updateSession': {
      const previous = getCachedSession(state, action.id)
      if (!previous || previous === action.session) {
        return state
      }
      return {
        ...state,
        sessionCache: { ...state.sessionCache, [action.id]: action.session },
        sessions: sameSummary(previous, action.session)
          ? state.sessions
          : sortSessions(
              state.sessions.map((summary) =>
                summary.id === action.id ? toSessionSummary(action.session) : summary
              )
            ),
      }
    }

    case 'renameUnloadedSession':
      return {
        ...state,
        sessions: state.sessions.map((session) =>
          session.id === action.id ? { ...session, title: action.title } : session
        ),
      }

    case 'markUnsaved':
      if (state.unsavedIds[action.id] === true) {
        return state
      }
      return {
        ...state,
        unsavedIds: { ...state.unsavedIds, [action.id]: true },
      }

    case 'markSaved': {
      if (getCachedSession(state, action.id) !== action.savedSession) {
        return state
      }
      const nextUnsaved = omitKey(state.unsavedIds, action.id)
      const nextSaveErrors = omitKey(state.saveErrors, action.id)
      if (nextUnsaved === state.unsavedIds && nextSaveErrors === state.saveErrors) {
        return state
      }
      return {
        ...state,
        unsavedIds: nextUnsaved,
        saveErrors: nextSaveErrors,
      }
    }

    case 'markSaveError':
      if (!getCachedSession(state, action.id) || state.saveErrors[action.id] === true) {
        return state
      }
      return {
        ...state,
        saveErrors: { ...state.saveErrors, [action.id]: true },
      }

    case 'setStreaming': {
      const prev = Object.hasOwn(state.activity, action.id) ? state.activity[action.id] : undefined
      if (action.active) {
        const compacting =
          prev?.kind === 'streaming' ? prev.compacting : prev?.kind === 'compacting'
        if (prev?.kind === 'streaming' && prev.compacting === compacting) {
          return state
        }
        return {
          ...state,
          activity: {
            ...state.activity,
            [action.id]: { kind: 'streaming', compacting },
          },
        }
      }
      if (!prev) {
        return state
      }
      return {
        ...state,
        activity: omitKey(state.activity, action.id),
      }
    }

    case 'setCompacting': {
      const prev = Object.hasOwn(state.activity, action.id) ? state.activity[action.id] : undefined
      if (action.active) {
        if (prev?.kind === 'streaming') {
          if (prev.compacting) {
            return state
          }
          return {
            ...state,
            activity: {
              ...state.activity,
              [action.id]: { kind: 'streaming', compacting: true },
            },
          }
        }
        if (prev?.kind === 'compacting') {
          return state
        }
        return {
          ...state,
          activity: {
            ...state.activity,
            [action.id]: { kind: 'compacting' },
          },
        }
      }
      if (!prev) {
        return state
      }
      if (prev.kind === 'streaming') {
        if (!prev.compacting) {
          return state
        }
        return {
          ...state,
          activity: {
            ...state.activity,
            [action.id]: { kind: 'streaming', compacting: false },
          },
        }
      }
      return {
        ...state,
        activity: omitKey(state.activity, action.id),
      }
    }

    case 'setDeleting': {
      const nextDeleting = action.deleting
        ? { ...state.deletingIds, [action.id]: true as const }
        : omitKey(state.deletingIds, action.id)
      return nextDeleting === state.deletingIds ? state : { ...state, deletingIds: nextDeleting }
    }

    case 'removeSession':
      return {
        ...state,
        sessions: state.sessions.filter((session) => session.id !== action.id),
        sessionCache: omitKey(state.sessionCache, action.id),
        loadErrors: omitKey(state.loadErrors, action.id),
        saveErrors: omitKey(state.saveErrors, action.id),
        unsavedIds: omitKey(state.unsavedIds, action.id),
        accessOrder: omitKey(state.accessOrder, action.id),
        activeId: state.activeId === action.id ? null : state.activeId,
      }

    case 'trimCache': {
      const victims = selectLruEvictions(state, action.limit)
      if (victims.length === 0) {
        return state
      }
      const evicted = new Set(victims)
      return {
        ...state,
        sessionCache: Object.fromEntries(
          Object.entries(state.sessionCache).filter(([id]) => !evicted.has(id))
        ),
        accessOrder: Object.fromEntries(
          Object.entries(state.accessOrder).filter(([id]) => !evicted.has(id))
        ),
      }
    }
  }
}
