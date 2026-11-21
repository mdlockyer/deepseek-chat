import { setLocale as setUiLocale, type Locale } from '@deepseek-chat/spine/i18n'
import type { KeyValueStore } from '@deepseek-chat/spine/ports'
import { normalizeLocation, type UserLocation } from './location.js'

/** Storage keys kept from the original app so saved choices survive the upgrade. */
const KEYS = {
  locale: 'chat-demo:locale',
  theme: 'chat-demo:theme-preference',
  location: 'chat-demo:location',
} as const

/** 主题偏好；默认跟随系统 */
export type ThemePreference = 'light' | 'dark' | 'system'

export type PreferencesDeps = {
  readonly store: KeyValueStore
  /** The browser's language tag (`navigator.language`). */
  readonly browserLanguage: string
}

export const createPreferences = ({ store, browserLanguage }: PreferencesDeps) => {
  // 位置选择模式跟随浏览器语言，与应用内选择的界面语言无关。
  const chineseBrowser = browserLanguage.toLowerCase().startsWith('zh')

  const savedLocale = store.get(KEYS.locale)
  const initialLocale: Locale =
    savedLocale === 'zh-CN' || savedLocale === 'en-US'
      ? savedLocale
      : chineseBrowser
        ? 'zh-CN'
        : 'en-US'

  const savedTheme = store.get(KEYS.theme)
  let theme: ThemePreference =
    savedTheme === 'light' || savedTheme === 'dark' ? savedTheme : 'system'

  const loadLocation = (): UserLocation | null => {
    try {
      const location = normalizeLocation(JSON.parse(store.get(KEYS.location) ?? 'null'))
      if (!location) {
        return null
      }
      return chineseBrowser
        ? location.region === 'CN' && location.province
          ? location
          : null
        : { region: location.region }
    } catch {
      return null
    }
  }
  let location = loadLocation()

  const listeners = new Set<() => void>()
  const notify = () => {
    for (const listener of [...listeners]) {
      listener()
    }
  }

  // 界面语言的运行时状态由 spine/i18n 持有；这里只负责持久化用户的选择。
  setUiLocale(initialLocale)

  return {
    usesProvinceLocation: chineseBrowser,
    setLocale: (locale: Locale) => {
      store.set(KEYS.locale, locale)
      setUiLocale(locale)
    },
    getThemePreference: () => theme,
    setThemePreference: (next: ThemePreference) => {
      store.set(KEYS.theme, next)
      theme = next
      notify()
    },
    getLocation: () => location,
    setLocation: (value: UserLocation | null) => {
      location = normalizeLocation(value)
      store.set(KEYS.location, location ? JSON.stringify(location) : null)
      notify()
    },
    subscribe: (listener: () => void) => {
      listeners.add(listener)
      return () => {
        listeners.delete(listener)
      }
    },
  }
}

export type Preferences = ReturnType<typeof createPreferences>
