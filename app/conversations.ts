/** The conversations slice instance with its app-provided ports. */
import { createConversationsSlice, type StreamTrace } from '@deepseek-chat/slice-conversations'
import { isDesktopApp } from './platform/desktop.js'
import { openSettings } from './settings/settingsDialogState.js'
import { createChatPanels } from './chatPanels.js'
import {
  API_ORIGIN,
  account,
  browser,
  httpFetch,
  preferences,
  setActivePanelSession,
  spine,
  voice,
} from './composition.js'
import { setSiderCollapsed } from './layout.js'
import { saveFile } from './saveFile.js'
import { late } from './lateBindings.js'
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
  // 开发诊断：流式请求时序交给开发服务器落盘（生产构建不包含）
  ...(__DEV__
    ? {
        onStreamTrace: (trace: StreamTrace) => {
          void fetch('/__dev/stream-trace', {
            method: 'POST',
            body: JSON.stringify({ at: new Date().toISOString(), ...trace }),
          }).catch(() => undefined)
        },
      }
    : {}),
  ui: {
    voice: {
      useVoiceInput: voice.useVoiceInput,
      VoiceButton: voice.VoiceButton,
      Spectrum: voice.Spectrum,
      ReadAloudButton: voice.ReadAloudButton,
      stopReadAloud: voice.readAloud.stop,
    },
    panels: createChatPanels(() => conversations, { browser: isDesktopApp }),
    openSettings,
    // 桌面版在内置浏览器中打开链接，网页版按普通链接打开
    openInApp: isDesktopApp ? (url) => void browser.openUrl(url, { initiator: 'user' }) : null,
    saveFile,
    setSiderCollapsed,
  },
})

late.stopReply = conversations.stopReply
late.loadFile = conversations.loadFile
