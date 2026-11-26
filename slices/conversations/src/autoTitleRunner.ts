import type { ChatModel, CreateMessageRequest, ModelProvider } from '@deepseek-chat/lib-agent'
import { buildAutoTitleRequest, parseAutoTitleResponse } from './autoTitle.js'
import { getVisibleMessages } from './branches.js'
import type { InlineAttachmentData } from './reply.js'
import type { AssistantMessage, Message, Session, UserMessage } from './types.js'

export type AutoTitleRunnerHost = {
  readonly enabled: boolean
  readonly provider: Pick<ModelProvider, 'id' | 'isConfigured' | 'streamMessage'>
  readonly getHistoryEpoch: () => number
  readonly isImportingHistory: () => boolean
  readonly isDeletingSession: (sessionId: string) => boolean
  readonly getSession: (sessionId: string) => Session | undefined
  readonly updateSession: (sessionId: string, updater: (session: Session) => Session) => void
  readonly persist: (sessionId: string) => void
}

export type AutoTitleParams = {
  readonly sessionId: string
  readonly epoch: number
  readonly model: ChatModel
  readonly system: string
  readonly tools: CreateMessageRequest['tools']
  readonly history: Message[]
  readonly question: UserMessage
  readonly reply: AssistantMessage
  readonly declaredClientNames: ReadonlySet<string>
  readonly inlineBlobs?: ReadonlyMap<string, InlineAttachmentData>
}

export const createAutoTitleRunner = (host: AutoTitleRunnerHost) => {
  const controllers = new Map<string, AbortController>()

  const cancel = (sessionId?: string) => {
    if (sessionId !== undefined) {
      const controller = controllers.get(sessionId)
      if (controller) {
        controllers.delete(sessionId)
        controller.abort()
      }
      return
    }
    for (const controller of controllers.values()) {
      controller.abort()
    }
    controllers.clear()
  }

  const run = (params: AutoTitleParams) => {
    const { sessionId, epoch, reply } = params
    const currentSession = host.getSession(sessionId)
    if (
      !host.enabled ||
      !currentSession ||
      currentSession.titleLocked ||
      epoch !== host.getHistoryEpoch() ||
      host.isImportingHistory() ||
      host.isDeletingSession(sessionId)
    ) {
      return
    }
    if (!host.provider.isConfigured()) {
      return
    }
    cancel(sessionId)
    const ac = new AbortController()
    controllers.set(sessionId, ac)
    const req = buildAutoTitleRequest({
      model: params.model,
      system: params.system,
      tools: params.tools,
      history: params.history,
      question: params.question,
      reply,
      declaredClientNames: params.declaredClientNames,
      currentTitle: currentSession.title,
      providerId: host.provider.id,
      inlineBlobs: params.inlineBlobs,
    })
    void (async () => {
      let rawText = ''
      try {
        for await (const event of host.provider.streamMessage(req, ac.signal)) {
          if (event.type === 'content_block_start' && event.content_block.type === 'tool_use') {
            ac.abort()
            return
          }
          if (event.type === 'content_block_delta' && event.delta.type === 'text_delta') {
            rawText += event.delta.text
          }
        }
        if (
          ac.signal.aborted ||
          epoch !== host.getHistoryEpoch() ||
          host.isImportingHistory() ||
          host.isDeletingSession(sessionId)
        ) {
          return
        }
        const latest = host.getSession(sessionId)
        if (!latest || latest.titleLocked || getVisibleMessages(latest).at(-1)?.id !== reply.id) {
          return
        }
        const nextTitle = parseAutoTitleResponse(rawText, latest.title)
        if (!nextTitle) {
          return
        }
        host.updateSession(sessionId, (session) =>
          session.titleLocked ? session : { ...session, title: nextTitle }
        )
        host.persist(sessionId)
      } catch {
        // Background title refresh never disturbs the main conversation.
      } finally {
        if (controllers.get(sessionId) === ac) {
          controllers.delete(sessionId)
        }
      }
    })()
  }

  return { run, cancel }
}
