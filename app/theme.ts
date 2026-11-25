import type { PreferencesSlice, ThemePreference } from '@deepseek-chat/slice-preferences'
import { applyDocumentTheme, type ThemeMode } from '@deepseek-chat/spine/design'
import { useSyncExternalStore } from 'react'

export type Theme = ThemeMode

const getMediaQuery = (): MediaQueryList | null =>
  typeof window !== 'undefined' && typeof window.matchMedia === 'function'
    ? window.matchMedia('(prefers-color-scheme: dark)')
    : null

const subscribeOsTheme = (listener: () => void) => {
  const query = getMediaQuery()
  if (!query) {
    return () => {}
  }
  query.addEventListener('change', listener)
  return () => query.removeEventListener('change', listener)
}

const getOsTheme = (): Theme => (getMediaQuery()?.matches ? 'dark' : 'light')

const resolveTheme = (preference: ThemePreference, osTheme: Theme): Theme =>
  preference === 'system' ? osTheme : preference

const useSystemPreference = (): ThemePreference => 'system'

/** Current effective theme for a given runtime (`preferences` may be null when omitted). */
export const useRuntimeTheme = (preferences: PreferencesSlice | null): Theme => {
  const usePref = preferences ? preferences.useThemePreference : useSystemPreference
  const preference = usePref()
  const osTheme = useSyncExternalStore<Theme>(subscribeOsTheme, getOsTheme, () => 'light')
  return resolveTheme(preference, osTheme)
}

const syncPageBackground = () => {
  const backgroundColor = getComputedStyle(document.body).backgroundColor
  document.documentElement.style.backgroundColor = backgroundColor
  document.querySelector('meta[name="theme-color"]')?.setAttribute('content', backgroundColor)
}

const applyTheme = (theme: Theme) => {
  const body = document.body
  body.classList.add('change-theme')
  applyDocumentTheme(document.documentElement, theme)
  if (document.readyState === 'complete') {
    syncPageBackground()
  }
  setTimeout(() => {
    body.classList.remove('change-theme')
  }, 0)
}

/** Syncs the document root theme once and whenever preference or OS dark mode changes. */
export const setupDocumentTheme = (preferences: PreferencesSlice | null): (() => void) => {
  let appliedTheme: Theme | null = null
  const sync = () => {
    const pref = preferences?.getThemePreference() ?? 'system'
    const theme = resolveTheme(pref, getOsTheme())
    if (theme !== appliedTheme) {
      appliedTheme = theme
      applyTheme(theme)
    }
  }
  sync()
  const onLoad = () => syncPageBackground()
  if (document.readyState !== 'complete') {
    window.addEventListener('load', onLoad, { once: true })
  }
  const unsubOs = subscribeOsTheme(sync)
  const unsubPref = preferences ? preferences.subscribe(sync) : () => {}
  return () => {
    window.removeEventListener('load', onLoad)
    unsubOs()
    unsubPref()
  }
}
