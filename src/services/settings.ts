import { create } from 'zustand'
import type { TtsVoice } from './api/speech.js'
import {
  isDesktopApp,
  loadFirecrawlApiKey,
  loadKeychainApiKey,
  saveFirecrawlApiKey,
  saveKeychainApiKey,
} from '../platform/desktop.js'
import { normalizeLocation, type UserLocation } from './location.js'

export type Locale = 'zh-CN' | 'en-US'

/** 主题偏好；默认跟随系统 */
export type ThemePreference = 'light' | 'dark' | 'system'

/** 本机设置，存 localStorage：API Key、语言、主题、位置、朗读音色、深度思考与智能搜索开关、侧边栏收起状态 */
type Settings = {
  apiKey: string | null
  firecrawlApiKey: string | null
  desktopSettingsReady: boolean
  locale: Locale
  themePreference: ThemePreference
  location: UserLocation | null
  ttsVoice: TtsVoice
  thinking: boolean
  search: boolean
  siderCollapsed: boolean
}

const KEYS = {
  apiKey: 'chat-demo:api-key',
  firecrawlApiKey: 'chat-demo:firecrawl-api-key',
  locale: 'chat-demo:locale',
  location: 'chat-demo:location',
  themePreference: 'chat-demo:theme-preference',
  ttsVoice: 'chat-demo:tts-voice',
  thinking: 'chat-demo:thinking',
  search: 'chat-demo:search',
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

/** 位置选择模式跟随浏览器语言，与应用内选择的界面语言无关。 */
export const isChineseBrowser = (): boolean =>
  (typeof navigator === 'undefined' ? 'zh' : navigator.language).toLowerCase().startsWith('zh')

const initialLocale = (): Locale => {
  const saved = read(KEYS.locale)
  if (saved === 'zh-CN' || saved === 'en-US') {
    return saved
  }
  return isChineseBrowser() ? 'zh-CN' : 'en-US'
}

const initialLocation = (): UserLocation | null => {
  try {
    const location = normalizeLocation(JSON.parse(read(KEYS.location) ?? 'null'))
    if (!location) {
      return null
    }
    return isChineseBrowser()
      ? location.region === 'CN' && location.province
        ? location
        : null
      : { region: location.region }
  } catch {
    return null
  }
}

/** 未保存过时跟随系统 */
const initialThemePreference = (): ThemePreference => {
  const saved = read(KEYS.themePreference)
  return saved === 'light' || saved === 'dark' ? saved : 'system'
}

/** 未保存过时使用服务端默认音色 stella（海星） */
const initialTtsVoice = (): TtsVoice => (read(KEYS.ttsVoice) === 'tide' ? 'tide' : 'stella')

export const useSettings = create<Settings>(() => ({
  // 桌面版的 API Key 在原生端读取，启动时由 loadDesktopSettings 读入。
  apiKey: isDesktopApp ? null : read(KEYS.apiKey),
  firecrawlApiKey: isDesktopApp ? null : read(KEYS.firecrawlApiKey),
  desktopSettingsReady: !isDesktopApp,
  locale: initialLocale(),
  location: initialLocation(),
  themePreference: initialThemePreference(),
  ttsVoice: initialTtsVoice(),
  thinking: read(KEYS.thinking) === 'true',
  search: read(KEYS.search) === 'true',
  siderCollapsed: read(KEYS.siderCollapsed) === 'true',
}))

export const setLocale = (locale: Locale) => {
  write(KEYS.locale, locale)
  useSettings.setState({ locale })
}

export const setLocation = (value: UserLocation | null) => {
  const location = normalizeLocation(value)
  write(KEYS.location, location ? JSON.stringify(location) : null)
  useSettings.setState({ location })
}

export const setThemePreference = (themePreference: ThemePreference) => {
  write(KEYS.themePreference, themePreference)
  useSettings.setState({ themePreference })
}

export const setTtsVoice = (ttsVoice: TtsVoice) => {
  write(KEYS.ttsVoice, ttsVoice)
  useSettings.setState({ ttsVoice })
}

/** 保存 API Key：网页版写 localStorage，桌面版写系统钥匙串（失败时抛出，由表单展示）。 */
export const setApiKey = async (apiKey: string | null): Promise<void> => {
  if (isDesktopApp) {
    await saveKeychainApiKey(apiKey)
  } else {
    write(KEYS.apiKey, apiKey)
  }
  useSettings.setState({ apiKey, desktopSettingsReady: true })
}

/** 保存 Firecrawl API Key：网页版写 localStorage，桌面版写私有存储。 */
export const setFirecrawlApiKey = async (firecrawlApiKey: string | null): Promise<void> => {
  const cleaned = firecrawlApiKey?.trim() || null
  if (isDesktopApp) {
    await saveFirecrawlApiKey(cleaned)
  } else {
    write(KEYS.firecrawlApiKey, cleaned)
  }
  useSettings.setState({ firecrawlApiKey: cleaned })
}

/**
 * 桌面版启动时从原生存储读取 API Key，须在首次渲染前完成。
 * 旧版本存在 localStorage 里的 Key 迁移到原生存储后从 localStorage 删除。
 */
export const loadDesktopSettings = async (): Promise<void> => {
  if (!isDesktopApp) {
    return
  }
  try {
    let apiKey = await loadKeychainApiKey().catch(() => null)
    const legacy = read(KEYS.apiKey)
    if (!apiKey && legacy) {
      await saveKeychainApiKey(legacy)
      apiKey = legacy
    }
    if (legacy) {
      write(KEYS.apiKey, null)
    }

    let firecrawlApiKey = await loadFirecrawlApiKey().catch(() => null)
    const legacyFirecrawl = read(KEYS.firecrawlApiKey)
    if (!firecrawlApiKey && legacyFirecrawl) {
      await saveFirecrawlApiKey(legacyFirecrawl)
      firecrawlApiKey = legacyFirecrawl
    }
    if (legacyFirecrawl) {
      write(KEYS.firecrawlApiKey, null)
    }

    useSettings.setState({ apiKey, firecrawlApiKey })
  } catch {
    // 存储不可用时按未设置处理，用户可在设置中重新输入。
  } finally {
    useSettings.setState({ desktopSettingsReady: true })
  }
}

export const setThinking = (thinking: boolean) => {
  write(KEYS.thinking, String(thinking))
  useSettings.setState({ thinking })
}

export const setSearch = (search: boolean) => {
  write(KEYS.search, String(search))
  useSettings.setState({ search })
}

export const setSiderCollapsed = (siderCollapsed: boolean) => {
  write(KEYS.siderCollapsed, String(siderCollapsed))
  useSettings.setState({ siderCollapsed })
}
