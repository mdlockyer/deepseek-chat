import type { EventLog } from '@deepseek-chat/spine/runtime'
import type { HttpFetch, KeyValueStore } from '@deepseek-chat/spine/ports'
import type { Locale } from '@deepseek-chat/spine/i18n'
import type { StreamTrace } from './streamTrace.js'
import type { ToolGateway } from './tools.js'
import type { ConversationsViewDeps } from './views.js'

/** Tunable runtime parameters for the conversations slice (see SPEC.md Parameters). */
export type ConversationsParams = {
  /** Maximum concurrent `read` tool calls in flight at once. */
  readonly maxParallelReadCalls: number
  /** Maximum tool rounds per lead reply (including returns from `wait`). */
  readonly toolRoundLimit: number
  /** Maximum children running concurrently in one reply. */
  readonly maxRunningChildren: number
  /** Maximum children started across one reply. */
  readonly maxChildrenPerReply: number
  /** Default timeout in seconds for `wait`. */
  readonly waitDefaultTimeoutS: number
  /**
   * Timeout in seconds for the `wait` the app adds itself when the lead ends its turn with children
   * still running. Children end at their own limits, so this only guards against a stalled stream.
   */
  readonly autoWaitTimeoutS: number
  /** Maximum posts a single child may write to the board. */
  readonly maxPostsPerChild: number
  /** Maximum characters per board post. */
  readonly maxPostChars: number
  /** Maximum characters retained in a finished child's stored tool_result blocks for display. */
  readonly childToolResultDisplayChars: number
}

export const DEFAULT_CONVERSATIONS_PARAMS: ConversationsParams = {
  maxParallelReadCalls: 6,
  toolRoundLimit: 50,
  maxRunningChildren: 5,
  maxChildrenPerReply: 12,
  waitDefaultTimeoutS: 60,
  autoWaitTimeoutS: 600,
  maxPostsPerChild: 6,
  maxPostChars: 400,
  childToolResultDisplayChars: 2000,
}

/** The ports the conversations slice runs on, given once at startup. */
export type ConversationsDeps = {
  readonly log: EventLog
  /** Origin of the DeepSeek API (requests go to `${apiOrigin}/anthropic/v1`). */
  readonly apiOrigin: string
  readonly fetch: HttpFetch
  /** Composer toggles (`chat-demo:thinking|search|python|browser`). */
  readonly store: KeyValueStore
  readonly tools: ToolGateway
  readonly getApiKey: () => string | null
  /** The user's location as text for the model, or '' when unset. */
  readonly getLocationLabel: (locale: Locale) => string
  /** The chat on screen changed (`null`: the new-chat screen). */
  readonly onActiveSessionChange: (sessionId: string | null) => void
  /** Whether the built-in browser exists (desktop); its composer toggle defaults off otherwise. */
  readonly browserAvailable: boolean
  /**
   * Diagnostics (optional; the app sets it in development): receives the timing of every streamed
   * request when it ends. Sizes and timings only, never content.
   */
  readonly onStreamTrace?: (trace: StreamTrace) => void
  /** Whether to run the detached cache-riding turn-end title refresh hook (default true). */
  readonly autoTitle?: boolean
  /** Optional overrides for tunable runtime parameters. */
  readonly params?: Partial<ConversationsParams>
  /** Ports for the chat's views. */
  readonly ui: ConversationsViewDeps
}

/** No API key: opens Settings on the key section. Returns whether a key is set. */
export const ensureApiKey = () => {
  if (deps().getApiKey()) {
    return true
  }
  deps().ui.openSettings('apiKey')
  return false
}

let current: ConversationsDeps | null = null

export const installDeps = (deps: ConversationsDeps) => {
  if (current) {
    throw new Error('The conversations slice is created once per app.')
  }
  current = deps
}

/** The installed ports; only valid after `createConversationsSlice`. */
export const deps = (): ConversationsDeps => {
  if (!current) {
    throw new Error('The conversations slice has not been created yet.')
  }
  return current
}

/** Resolved tunable parameters for the installed slice. */
export const runtimeParams = (): ConversationsParams => ({
  ...DEFAULT_CONVERSATIONS_PARAMS,
  ...deps().params,
})
