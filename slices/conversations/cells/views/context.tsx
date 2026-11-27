import type { ModelProvider } from '@deepseek-chat/lib-agent'
import type { ToolRegistry } from '@deepseek-chat/lib-tools'
import type { BlobStore } from '@deepseek-chat/spine/ports'
import { createContext, createElement, useContext, type ComponentType } from 'react'
import type {
  ConversationsKernelState,
  DraftsPort,
  LinkedMessage,
  ReadingPositions,
  UploadsPort,
} from '../../kernel/index.js'
import type { ConversationsViewDeps } from './views.js'

export type ActivityTargetRef = {
  readonly sessionId: string
  readonly messageId: string
  readonly tab: 'activity' | 'sources'
  readonly callId?: string
}

/** Narrow runtime surface consumed by the conversations view cell (zero coupling to `src/runtime.ts`). */
export type ConversationsViewRuntime = {
  readonly deps: { readonly ui: ConversationsViewDeps }
  readonly tools: ToolRegistry
  readonly blobs: BlobStore
  readonly provider: Pick<ModelProvider, 'defaultModel' | 'modelSpec'>
  readonly uploads: UploadsPort
  readonly drafts: DraftsPort
  readonly useChatState: <T>(selector: (state: ConversationsKernelState) => T) => T
  readonly getChatState: () => ConversationsKernelState
  readonly subscribeChatState: (
    listener: (state: ConversationsKernelState, previous: ConversationsKernelState) => void
  ) => () => void
  readonly useThinking: <T>(selector: (state: { thinking: boolean }) => T) => T
  readonly setThinking: (thinking: boolean) => void
  readonly useMobileSider: <T>(selector: (state: { open: boolean }) => T) => T
  readonly openMobileSider: () => void
  readonly closeMobileSider: () => void
  readonly showNotice: (notice: LinkedMessage) => void
  readonly ensureApiKey: () => boolean
  readonly bindChatPersistence: () => () => void
  readonly retrySaveSessions: () => void
  readonly initChat: () => Promise<void>
  readonly newChat: () => void
  readonly selectSession: (id: string) => void
  readonly renameSession: (id: string, title: string) => void
  readonly removeSession: (id: string) => Promise<boolean>
  readonly sendMessage: (sessionId: string | null) => boolean
  readonly regenerateReply: (sessionId: string, messageId?: string) => void
  readonly editMessage: (sessionId: string, messageId: string, content: string) => boolean
  readonly selectMessageVersion: (sessionId: string, messageId: string) => void
  readonly continueReply: (sessionId: string, messageId: string) => void
  readonly retryUpload: (sessionId: string, messageId: string) => void
  readonly stopReply: (sessionId: string) => void
  readonly compactSession: (
    sessionId: string
  ) => Promise<'compacted' | 'notNeeded' | 'cancelled' | 'failed'>
  readonly requestTurnInspection: (
    sessionId: string,
    messageId: string,
    tab: 'activity' | 'sources',
    callId?: string
  ) => void
  readonly activity: {
    readonly useActiveTarget: () => ActivityTargetRef | null
    readonly HeaderToggle: ComponentType<{ readonly sessionId: string }>
  } | null
  readonly reading: ReadingPositions
}

const ConversationsContext = createContext<ConversationsViewRuntime | null>(null)

export const ConversationsProvider = ConversationsContext.Provider

export const useConversations = (): ConversationsViewRuntime => {
  const runtime = useContext(ConversationsContext)
  if (!runtime) {
    throw new Error('Conversations UI components must be rendered through a slice instance.')
  }
  return runtime
}

/** Wraps a view component so it always binds to its owning slice runtime instance. */
export const bindView = <P extends object>(
  runtime: ConversationsViewRuntime,
  Component: ComponentType<P>
): ComponentType<P> => {
  const Bound = (props: P) =>
    createElement(ConversationsProvider, { value: runtime }, createElement(Component, props))
  Bound.displayName = `Conversations(${Component.displayName ?? Component.name ?? 'View'})`
  return Bound
}
