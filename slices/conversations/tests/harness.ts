import { createToolRegistry } from '@deepseek-chat/lib-tools'
import { memoryBlobStore, memoryStore } from '@deepseek-chat/spine/ports'
import { EventLog } from '@deepseek-chat/spine/runtime'
import {
  createConversationsSlice,
  memorySessionStore,
  type ConversationsDeps,
} from '@deepseek-chat/slice-conversations'

/** Creates an isolated conversations slice instance with in-memory offline ports. */
export const createTestSlice = (overrides: Partial<ConversationsDeps> = {}) =>
  createConversationsSlice({
    log: new EventLog(),
    apiOrigin: 'https://api.test',
    fetch: (url, init) => globalThis.fetch(url, init),
    store: memoryStore(),
    blobs: memoryBlobStore(),
    sessions: memorySessionStore(),
    tools: createToolRegistry([]),
    platform: 'web',
    getApiKey: () => 'sk-test',
    getLocationLabel: () => '',
    ui: {
      voice: null,
      openSettings: () => {},
      openInApp: null,
      saveFile: async () => {},
      setSiderCollapsed: () => {},
    },
    ...overrides,
  })
