import type { PanelSlot } from '@deepseek-chat/spine/design'
import { memoryStore } from '@deepseek-chat/spine/ports'
import { EventLog } from '@deepseek-chat/spine/runtime'
import {
  createConversationsSlice,
  type ConversationsDeps,
  type ToolKind,
} from '@deepseek-chat/slice-conversations'

/** A closed right-panel slot with no chat on screen. */
const fakeSearchSlot = (): PanelSlot => ({
  useStageSize: () => null,
  setStageSize: () => {},
  setResizing: () => {},
  isResizing: () => false,
  isOpen: () => false,
  open: () => {},
  close: () => {},
  setAnimating: () => {},
  getLayout: () => ({
    activeSessionId: null,
    animating: false,
    resizing: false,
    overlayLocked: false,
    width: 540,
  }),
  subscribe: () => () => {},
  useLayout: (select) =>
    select({
      activeSessionId: null,
      animating: false,
      resizing: false,
      overlayLocked: false,
      width: 540,
    }),
})

/** Tool names as the app maps them from the slices that own them. */
const KINDS: Record<string, ToolKind> = {
  web_search: 'web_search',
  web_scrape: 'web_scrape',
  present_file: 'present_file',
  edit_file: 'edit_file',
  read_file: 'read_file',
  python: 'python',
  ask_user: 'ask_user',
}

/**
 * Creates the slice once for this test file (one instance per process, like the app) with
 * offline ports. `fetch` defers to `globalThis.fetch` so tests can replace it.
 */
export const installTestSlice = (overrides: Partial<ConversationsDeps> = {}) =>
  createConversationsSlice({
    log: new EventLog(),
    apiOrigin: 'https://api.test',
    fetch: (url, init) => globalThis.fetch(url, init),
    store: memoryStore(),
    tools: {
      declare: () => [],
      instructions: () => [],
      kindOf: (name) => KINDS[name] ?? (name.startsWith('browser_') ? 'browser' : null),
      // Only the extensions these tests use.
      fenceLanguage: (path) => (path.endsWith('.html') ? 'html' : 'text'),
      run: async (call) => ({ content: `Unknown tool: ${call.name}`, status: 'error' }),
    },
    getApiKey: () => 'sk-test',
    getLocationLabel: () => '',
    onActiveSessionChange: () => {},
    browserAvailable: false,
    ui: {
      voice: {
        useVoiceInput: () => ({
          status: 'idle',
          seconds: 0,
          available: false,
          getAnalyser: () => null,
          toggle: () => {},
          cancel: () => {},
        }),
        VoiceButton: () => null,
        Spectrum: () => null,
        ReadAloudButton: () => null,
        stopReadAloud: () => {},
      },
      panels: {
        files: {
          useIsShown: () => false,
          open: () => {},
          useToggle: () => ({ visible: false, open: false, toggle: () => {} }),
        },
        browser: null,
        search: fakeSearchSlot(),
      },
      openSettings: () => {},
      openInApp: null,
      saveFile: async () => {},
      setSiderCollapsed: () => {},
    },
    ...overrides,
  })
