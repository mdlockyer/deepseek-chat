import type { Locale } from '@deepseek-chat/spine/i18n'
import { locationLabel } from './location.js'
import { createPreferences, type PreferencesDeps } from './preferences.js'
import { createViews } from './views.js'

export type { UserLocation } from './location.js'
export type { PreferencesDeps, ThemePreference } from './preferences.js'

export const createPreferencesSlice = (deps: PreferencesDeps) => {
  const preferences = createPreferences(deps)
  const views = createViews(preferences)
  return {
    setLocale: preferences.setLocale,
    getThemePreference: preferences.getThemePreference,
    setThemePreference: preferences.setThemePreference,
    useThemePreference: views.useThemePreference,
    getLocation: preferences.getLocation,
    setLocation: preferences.setLocation,
    useLocation: views.useLocation,
    /** Notified when the theme or location changes. */
    subscribe: preferences.subscribe,
    /** The location in words for the model; `''` when unset. */
    getLocationLabel: (locale: Locale) => locationLabel(preferences.getLocation(), locale),
    /** Location is picked as a Chinese province/city (Chinese browser) or a country. */
    usesProvinceLocation: preferences.usesProvinceLocation,
    ThemeSetting: views.ThemeSetting,
    LocaleSetting: views.LocaleSetting,
    LocationSetting: views.LocationSetting,
    dispose: preferences.dispose,
  }
}

export type PreferencesSlice = ReturnType<typeof createPreferencesSlice>
