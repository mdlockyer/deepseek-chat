import type { ToolCapability } from '@deepseek-chat/lib-tools'
import type { SessionDeleted, SessionHistoryReplaced } from '@deepseek-chat/spine/facts/session'
import { serializeSubagentForArchive, subagentsPresenter } from './presenter.js'
import {
  createReplySubagentRuntime,
  settleHydratedSubagentsState,
  type ReplySubagentRuntime,
} from './runtime.js'
import {
  AUTO_WAIT_ID_PREFIX,
  POST_TOOL_NAME,
  WAIT_TOOL_NAME,
  buildLeadSubagentInstructions,
  createLeadPostTool,
  createWaitTool,
} from './tools.js'
import {
  DEFAULT_SUBAGENTS_PARAMS,
  isSubagentsReplyState,
  type SubagentsParams,
  type SubagentsReplyState,
  type SubagentsSliceDeps,
  type SubagentsToolHost,
} from './types.js'

export { POST_TOOL_NAME, WAIT_TOOL_NAME }
export type { SubagentsParams, SubagentsSliceDeps, SubagentsToolHost }

const waitWithSignal = (ms: number, signal: AbortSignal): Promise<void> =>
  new Promise((resolve, reject) => {
    if (signal.aborted) {
      reject(signal.reason ?? new DOMException('Aborted', 'AbortError'))
      return
    }
    const timer = setTimeout(() => {
      signal.removeEventListener('abort', onAbort)
      resolve()
    }, ms)
    const onAbort = () => {
      clearTimeout(timer)
      reject(signal.reason ?? new DOMException('Aborted', 'AbortError'))
    }
    signal.addEventListener('abort', onAbort, { once: true })
  })

export const createSubagentsSlice = (deps: SubagentsSliceDeps) => {
  const params: SubagentsParams = { ...DEFAULT_SUBAGENTS_PARAMS, ...deps.params }
  const newId = deps.newId ?? (() => crypto.randomUUID())
  const activeRuntimes = new Map<string, { sessionId: string; runtime: ReplySubagentRuntime }>()

  const runtimeKey = (sessionId: string, replyId: string) => `${sessionId}:${replyId}`

  const getOrCreateRuntime = (
    sessionId: string,
    replyId: string,
    readReplyState: () => unknown,
    writeReplyState: (next: unknown, opts?: { readonly persist?: boolean }) => void
  ): ReplySubagentRuntime => {
    const key = runtimeKey(sessionId, replyId)
    const existing = activeRuntimes.get(key)
    if (existing) {
      return existing.runtime
    }
    const raw = readReplyState()
    const initialState: SubagentsReplyState = isSubagentsReplyState(raw)
      ? raw
      : { agents: [], board: [] }
    const runtime = createReplySubagentRuntime({
      initialState,
      provider: deps.provider,
      tools: deps.toolHost,
      params,
      newId,
      retry: {
        limit: params.networkRetryLimit,
        wait: (attempt, signal) => waitWithSignal(params.retryBaseDelayMs * 2 ** attempt, signal),
      },
      onSync: (state, persist) => writeReplyState(state, { persist }),
    })
    activeRuntimes.set(key, { sessionId, runtime })
    return runtime
  }

  const stopSession = (sessionId: string) => {
    for (const [key, entry] of activeRuntimes) {
      if (entry.sessionId === sessionId) {
        activeRuntimes.delete(key)
        void entry.runtime.stopAll('user')
      }
    }
  }

  const stopAllSessions = () => {
    for (const [key, entry] of activeRuntimes) {
      activeRuntimes.delete(key)
      void entry.runtime.stopAll('interrupted')
    }
  }

  const unsubscribers = [
    deps.log.subscribe<SessionDeleted>('SessionDeleted', ({ fact }) => {
      stopSession(fact.sessionId)
    }),
    deps.log.subscribe<SessionHistoryReplaced>('SessionHistoryReplaced', () => {
      stopAllSessions()
    }),
  ]

  const isSpawnTool = (name: string) => deps.toolHost.agentProfile(name) !== null

  const capability: ToolCapability = {
    id: 'subagents',
    declareTools: ({ declaredToolsSoFar }) => {
      const hasSubagent = declaredToolsSoFar.some((tool) => isSpawnTool(tool.name))
      return hasSubagent ? [createWaitTool(params), createLeadPostTool(params)] : []
    },
    instructions: (declaredNames, audience) => {
      if (audience !== 'reply') {
        return null
      }
      return declaredNames.has(WAIT_TOOL_NAME) || declaredNames.has(POST_TOOL_NAME)
        ? buildLeadSubagentInstructions()
        : null
    },
    handles: (name) => name === WAIT_TOOL_NAME || name === POST_TOOL_NAME || isSpawnTool(name),
    effectOf: (name) => (isSpawnTool(name) ? 'spawn' : 'session'),
    run: async (call, ctx) => {
      const runtime = getOrCreateRuntime(
        ctx.sessionId,
        ctx.replyId,
        ctx.readReplyState,
        ctx.writeReplyState
      )
      if (call.name === POST_TOOL_NAME) {
        return runtime.postFromLead(call.input)
      }
      if (call.name === WAIT_TOOL_NAME) {
        return runtime.wait(
          call.input,
          ctx,
          call.id.startsWith(AUTO_WAIT_ID_PREFIX)
            ? { defaultTimeoutS: params.autoWaitTimeoutS }
            : undefined
        )
      }
      return runtime.spawn(call, ctx)
    },
    presenter: subagentsPresenter,
    serializeForArchive: serializeSubagentForArchive,
    turnHooks: {
      onTurnEndWithoutToolCalls: ({ sessionId, replyId }) => {
        const entry = activeRuntimes.get(runtimeKey(sessionId, replyId))
        if (!entry || !entry.runtime.hasRunning()) {
          return null
        }
        return {
          syntheticCall: {
            id: `${AUTO_WAIT_ID_PREFIX}${newId().slice(0, 8)}`,
            name: WAIT_TOOL_NAME,
            input: { until: 'all', timeout_s: params.autoWaitTimeoutS },
          },
        }
      },
      onTurnSettled: ({ sessionId, replyId, reason }) => {
        const key = runtimeKey(sessionId, replyId)
        const entry = activeRuntimes.get(key)
        if (!entry) {
          return
        }
        activeRuntimes.delete(key)
        if (reason !== 'done') {
          void entry.runtime.stopAll(reason)
        }
      },
      onReplyHydrated: (raw) =>
        isSubagentsReplyState(raw) ? settleHydratedSubagentsState(raw) : raw,
    },
  }

  return {
    capability,
    dispose: () => {
      stopAllSessions()
      for (const unsubscribe of unsubscribers) {
        unsubscribe()
      }
    },
  }
}

export type SubagentsSlice = ReturnType<typeof createSubagentsSlice>
