import type { ToolCapability } from '@deepseek-chat/lib-tools'
import type { SessionDeleted, SessionHistoryReplaced } from '@deepseek-chat/spine/facts/session'
import type { EventLog } from '@deepseek-chat/spine/runtime'
import { createAskUserDock } from './AskUserCard.js'
import {
  ASK_USER_INSTRUCTIONS,
  ASK_USER_TOOL,
  ASK_USER_TOOL_NAME,
  createAskUserState,
  parseAskUserInput,
  type AskActionItem,
  type AskActionMeta,
  type AskUserOption,
  type AskUserQuestion,
  type ParseAskUserResult,
  type PendingAskUser,
} from './askUser.js'
import { askUserPresenter, serializeAskForArchive } from './presenter.js'

export {
  ASK_USER_INSTRUCTIONS,
  ASK_USER_TOOL,
  ASK_USER_TOOL_NAME,
  parseAskUserInput,
  type AskActionItem,
  type AskActionMeta,
  type AskUserOption,
  type AskUserQuestion,
  type ParseAskUserResult,
  type PendingAskUser,
}

export type AskUserSliceDeps = {
  readonly log: EventLog
}

export const createAskUserSlice = (deps: AskUserSliceDeps) => {
  const state = createAskUserState()
  const ComposerDock = createAskUserDock(state)

  const unsubscribers = [
    deps.log.subscribe<SessionDeleted>('SessionDeleted', ({ fact }) => {
      state.cancelSession(fact.sessionId)
    }),
    deps.log.subscribe<SessionHistoryReplaced>('SessionHistoryReplaced', () => {
      state.cancelAll()
    }),
  ]

  const capability: ToolCapability = {
    id: 'ask-user',
    declareTools: () => [ASK_USER_TOOL],
    instructions: (names, audience) =>
      audience === 'reply' && names.has(ASK_USER_TOOL_NAME) ? ASK_USER_INSTRUCTIONS : null,
    describe: (name, audience) =>
      audience === 'reply' && name === ASK_USER_TOOL_NAME ? ASK_USER_TOOL : null,
    handles: (name) => name === ASK_USER_TOOL_NAME,
    effectOf: () => 'interactive',
    run: (call, ctx) => state.run(call.input, { sessionId: ctx.sessionId, signal: ctx.signal }),
    presenter: askUserPresenter,
    serializeForArchive: serializeAskForArchive,
  }

  return {
    toolName: ASK_USER_TOOL_NAME,
    tool: ASK_USER_TOOL,
    instructions: ASK_USER_INSTRUCTIONS,
    capability,
    ComposerDock,
    useHasPending: (sessionId: string): boolean =>
      state.useStore((s) => Boolean(s.pendingBySession[sessionId])),
    run: state.run,
    submit: state.submit,
    skip: state.skip,
    dispose: () => {
      state.cancelAll()
      for (const unsubscribe of unsubscribers) {
        unsubscribe()
      }
    },
  }
}

export type AskUserSlice = ReturnType<typeof createAskUserSlice>
