/** The conversations slice instance with its app-provided ports. */
import { createConversationsSlice } from '@deepseek-chat/slice-conversations'
import { isDesktopApp } from '../platform/desktop.js'
import {
  API_ORIGIN,
  account,
  httpFetch,
  preferences,
  setActivePanelSession,
  spine,
} from './composition.js'
import { localStore } from './storage.js'
import { toolGateway } from './toolGateway.js'

export const conversations = createConversationsSlice({
  log: spine,
  apiOrigin: API_ORIGIN,
  fetch: httpFetch,
  store: localStore,
  tools: toolGateway,
  getApiKey: () => account.getApiKey(),
  getLocationLabel: (locale) => preferences.getLocationLabel(locale),
  onActiveSessionChange: setActivePanelSession,
  browserAvailable: isDesktopApp,
})
