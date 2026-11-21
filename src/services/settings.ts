import { create } from 'zustand'

/** 本机设置，存 localStorage：深度思考、智能搜索、运行代码、内置浏览器与面板状态 */
type Settings = {
  thinking: boolean
  search: boolean
  python: boolean
  browser: boolean
  browserPanelWidth: number
  browserAllowLocalhost: boolean
  siderCollapsed: boolean
}

const KEYS = {
  thinking: 'chat-demo:thinking',
  search: 'chat-demo:search',
  python: 'chat-demo:python',
  browser: 'chat-demo:browser',
  browserPanelWidth: 'chat-demo:browser-panel-width',
  browserAllowLocalhost: 'chat-demo:browser-allow-localhost',
  siderCollapsed: 'chat-demo:sider-collapsed',
} as const

const read = (key: string) => {
  try {
    return localStorage.getItem(key)
  } catch {
    return null
  }
}

const write = (key: string, value: string | null) => {
  try {
    if (value === null) {
      localStorage.removeItem(key)
    } else {
      localStorage.setItem(key, value)
    }
  } catch {
    // 存储不可用时只在内存中生效
  }
}

const DEFAULT_BROWSER_PANEL_WIDTH = 540
const clampBrowserPanelWidth = (value: number) =>
  Number.isFinite(value)
    ? Math.min(Math.max(Math.round(value), 360), 1100)
    : DEFAULT_BROWSER_PANEL_WIDTH

const initialBrowserPanelWidth = (): number => {
  const parsed = Number(read(KEYS.browserPanelWidth))
  return parsed > 0 ? clampBrowserPanelWidth(parsed) : DEFAULT_BROWSER_PANEL_WIDTH
}

export const useSettings = create<Settings>(() => ({
  thinking: read(KEYS.thinking) === 'true',
  search: read(KEYS.search) === 'true',
  python: read(KEYS.python) === 'true',
  browser: read(KEYS.browser) === 'true',
  browserPanelWidth: initialBrowserPanelWidth(),
  browserAllowLocalhost: read(KEYS.browserAllowLocalhost) === 'true',
  siderCollapsed: read(KEYS.siderCollapsed) === 'true',
}))

export const setThinking = (thinking: boolean) => {
  write(KEYS.thinking, String(thinking))
  useSettings.setState({ thinking })
}

export const setSearch = (search: boolean) => {
  write(KEYS.search, String(search))
  useSettings.setState({ search })
}

export const setPython = (python: boolean) => {
  write(KEYS.python, String(python))
  useSettings.setState({ python })
}

export const setBrowser = (browser: boolean) => {
  write(KEYS.browser, String(browser))
  useSettings.setState({ browser })
}

export const setBrowserPanelWidth = (width: number) => {
  const clamped = clampBrowserPanelWidth(width)
  write(KEYS.browserPanelWidth, String(clamped))
  useSettings.setState({ browserPanelWidth: clamped })
}

export const setBrowserAllowLocalhost = (allow: boolean) => {
  write(KEYS.browserAllowLocalhost, String(allow))
  useSettings.setState({ browserAllowLocalhost: allow })
}

export const setSiderCollapsed = (siderCollapsed: boolean) => {
  write(KEYS.siderCollapsed, String(siderCollapsed))
  useSettings.setState({ siderCollapsed })
}
