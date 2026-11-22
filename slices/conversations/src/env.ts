import type { EventLog } from '@deepseek-chat/spine/runtime'
import type { HttpFetch, KeyValueStore } from '@deepseek-chat/spine/ports'
import type { Locale } from '@deepseek-chat/spine/i18n'
import type { StreamTrace } from './streamTrace.js'
import type { ToolGateway } from './tools.js'
import type { ConversationsViewDeps } from './views.js'

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
