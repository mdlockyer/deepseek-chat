import { create } from 'zustand'
import { localStore } from '../../app/storage.js'

/** 内置浏览器与右侧面板的本机偏好；存 localStorage，沿用原有键名 */
type BrowserPrefs = {
  panelWidth: number
  allowLocalhost: boolean
}

const KEYS = {
  panelWidth: 'chat-demo:browser-panel-width',
  allowLocalhost: 'chat-demo:browser-allow-localhost',
} as const

const DEFAULT_PANEL_WIDTH = 540
const clampPanelWidth = (value: number) =>
  Number.isFinite(value) ? Math.min(Math.max(Math.round(value), 360), 1100) : DEFAULT_PANEL_WIDTH

const initialPanelWidth = (): number => {
  const parsed = Number(localStore.get(KEYS.panelWidth))
  return parsed > 0 ? clampPanelWidth(parsed) : DEFAULT_PANEL_WIDTH
}

export const useBrowserPrefs = create<BrowserPrefs>(() => ({
  panelWidth: initialPanelWidth(),
  allowLocalhost: localStore.get(KEYS.allowLocalhost) === 'true',
}))

export const setBrowserPanelWidth = (width: number) => {
  const panelWidth = clampPanelWidth(width)
  localStore.set(KEYS.panelWidth, String(panelWidth))
  useBrowserPrefs.setState({ panelWidth })
}

export const setBrowserAllowLocalhost = (allowLocalhost: boolean) => {
  localStore.set(KEYS.allowLocalhost, String(allowLocalhost))
  useBrowserPrefs.setState({ allowLocalhost })
}
