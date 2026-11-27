import { createDeepSeekProvider } from '@deepseek-chat/lib-agent'
import { createToolRegistry } from '@deepseek-chat/lib-tools'
import type { HttpFetch } from '@deepseek-chat/spine/ports'
import { EventLog } from '@deepseek-chat/spine/runtime'
import { memoryBlobStore, memoryStore } from '@deepseek-chat/test-support'
import {
  createConversationsSlice,
  type ConversationsDeps,
} from '@deepseek-chat/slice-conversations'
import { memorySessionStore } from './memorySessionStore.js'

export type TestSliceOverrides = Partial<ConversationsDeps> & {
  readonly apiOrigin?: string
  readonly fetch?: HttpFetch
  readonly getApiKey?: () => string | null
}

/** Creates an isolated conversations slice instance with in-memory offline ports. */
export const createTestSlice = (overrides: TestSliceOverrides = {}) => {
  const { apiOrigin, fetch, getApiKey, provider, ...rest } = overrides
  return createConversationsSlice({
    log: new EventLog(),
    provider:
      provider ??
      createDeepSeekProvider({
        apiOrigin: apiOrigin ?? 'https://api.test',
        fetch: fetch ?? ((url, init) => globalThis.fetch(url, init)),
        getApiKey: getApiKey ?? (() => 'sk-test'),
      }),
    store: memoryStore(),
    blobs: memoryBlobStore(),
    sessions: memorySessionStore(),
    tools: createToolRegistry([]),
    platform: 'web',
    getLocationLabel: () => '',
    ui: {
      voice: null,
      openSettings: () => {},
      openInApp: null,
      saveFile: async () => {},
      setSiderCollapsed: () => {},
    },
    ...rest,
  })
}
