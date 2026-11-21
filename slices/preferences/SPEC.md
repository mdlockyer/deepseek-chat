# SPEC: `slices/preferences` (language, theme, location)

## Purpose

Owns the user's app-wide personal preferences: the interface language, the light/dark theme
preference, and an optional location used to ground answers. Stores each, offers its settings rows,
and answers questions about them. It does not apply them: the spine's i18n holds the live locale,
and the app applies the theme to the page.

## Public entrypoint

`createPreferencesSlice({ store, browserLanguage })` returns:

| Member                                                                                  | Meaning                                                                 |
| :-------------------------------------------------------------------------------------- | :---------------------------------------------------------------------- |
| `setLocale(locale)`                                                                     | Save the language and make it the live UI locale (spine i18n).          |
| `getThemePreference()` / `setThemePreference(p)` / `subscribe` / `useThemePreference()` | `'light' \| 'dark' \| 'system'`.                                        |
| `getLocation()` / `setLocation(location \| null)` / `useLocation()`                     | `{ region, province?, city? }` or `null`.                               |
| `getLocationLabel(locale)`                                                              | The location as words for the model, `''` when unset.                   |
| `usesProvinceLocation`                                                                  | Whether location is picked as a Chinese province/city (else a country). |
| `ThemeSetting`, `LocaleSetting`, `LocationSetting`                                      | Settings rows.                                                          |

`browserLanguage` is the browser's language tag (`navigator.language`).

## Behavioural invariants

1. **Initial locale.** A saved `chat-demo:locale` of `zh-CN` or `en-US` wins; otherwise `zh-CN` if
   `browserLanguage` starts with `zh` (case-insensitive), else `en-US`. It is pushed to the spine
   when the slice is created. `setLocale` saves it and pushes it.
2. **Theme.** Saved under `chat-demo:theme-preference`. `light` or `dark` as saved; anything else
   (including unset) is `system`. `setThemePreference` saves it and notifies subscribers.
3. **Location mode follows the browser, not the UI language.** `usesProvinceLocation` is true when
   `browserLanguage` starts with `zh`.
4. **Location validity.** A location is valid only if its region is a known region code; a `CN`
   location may add a known province, and a city only of that province. Anything else is `null`.
   Non-`CN` locations keep only the region.
5. **Location load.** Saved as JSON under `chat-demo:location`. Unreadable or invalid → `null`. In
   province mode only a `CN` location with a province is kept; in region mode only `{ region }` is
   kept.
6. **Location save.** `setLocation` stores the validated value (or removes the key for `null` or an
   invalid value) and notifies subscribers.
7. **Location label.** `CN` with locale `zh-CN`: the city name, else the province name, else the
   region name. Otherwise the region's display name in the locale. Unset → `''`.
8. **Storage unavailable** (the store drops writes): values still change for this session.

## Facts

None. The app reads preferences top-down.

## Ownership notes

- The province/city table (`locationData.ts`) is static data and lives here as the only consumer.
