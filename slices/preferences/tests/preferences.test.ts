import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { createLocaleStore, type LocaleStore } from '@deepseek-chat/spine/i18n'
import { memoryStore, type KeyValueStore } from '@deepseek-chat/spine/ports'
import { createPreferencesSlice } from '@deepseek-chat/slice-preferences'

const LOCALE = 'chat-demo:locale'
const THEME = 'chat-demo:theme-preference'
const LOCATION = 'chat-demo:location'

// Fixture codes from the province/city table: 440000 广东省 contains 440100 广州市;
// 110000 北京市 contains 110100, which is not in 广东省.
const GUANGDONG = '440000'
const GUANGZHOU = '440100'
const BEIJING_CITY = '110100'

const slice = (
  initial: Record<string, string> = {},
  browserLanguage = 'en-US',
  locale?: LocaleStore
) => {
  const store = memoryStore(initial)
  return { prefs: createPreferencesSlice({ store, browserLanguage, locale }), store }
}

const savedLocation = (value: unknown) => ({ [LOCATION]: JSON.stringify(value) })

describe('preferences: locale', () => {
  it('uses a saved locale over the browser language', () => {
    const locale = createLocaleStore('zh-CN')
    const { prefs } = slice({ [LOCALE]: 'en-US' }, 'zh-CN', locale)
    assert.equal(locale.get(), 'en-US')
    assert.equal(prefs.getLocale(), 'en-US')
  })

  it('falls back to the browser language: zh* → zh-CN, anything else → en-US', () => {
    const zh = createLocaleStore('en-US')
    slice({ [LOCALE]: 'fr-FR' }, 'ZH-tw', zh)
    assert.equal(zh.get(), 'zh-CN')
    const en = createLocaleStore('zh-CN')
    slice({}, 'en-GB', en)
    assert.equal(en.get(), 'en-US')
  })

  it('saves a chosen locale and isolates separate slice instances', () => {
    const localeA = createLocaleStore('en-US')
    const localeB = createLocaleStore('en-US')
    const { prefs: prefsA, store: storeA } = slice({}, 'en-US', localeA)
    const { prefs: prefsB } = slice({}, 'en-US', localeB)
    prefsA.setLocale('zh-CN')
    assert.equal(storeA.get(LOCALE), 'zh-CN')
    assert.equal(localeA.get(), 'zh-CN')
    assert.equal(prefsA.getLocale(), 'zh-CN')
    assert.equal(localeB.get(), 'en-US')
    assert.equal(prefsB.getLocale(), 'en-US')
  })
})

describe('preferences: theme', () => {
  it('reads light or dark as saved, and anything else as system', () => {
    assert.equal(slice({ [THEME]: 'dark' }).prefs.getThemePreference(), 'dark')
    assert.equal(slice({ [THEME]: 'light' }).prefs.getThemePreference(), 'light')
    assert.equal(slice({ [THEME]: 'sepia' }).prefs.getThemePreference(), 'system')
    assert.equal(slice().prefs.getThemePreference(), 'system')
  })

  it('saves a new preference and notifies subscribers', () => {
    const { prefs, store } = slice()
    const seen: string[] = []
    prefs.subscribe(() => seen.push(prefs.getThemePreference()))

    prefs.setThemePreference('dark')

    assert.equal(store.get(THEME), 'dark')
    assert.deepEqual(seen, ['dark'])
  })
})

describe('preferences: location mode follows the browser language', () => {
  it('uses provinces for a Chinese browser and countries otherwise', () => {
    assert.equal(slice({}, 'zh-HK').prefs.usesProvinceLocation, true)
    assert.equal(slice({}, 'en-US').prefs.usesProvinceLocation, false)
  })

  it('province mode keeps only a CN location with a province', () => {
    const full = { region: 'CN', province: GUANGDONG, city: GUANGZHOU }
    assert.deepEqual(slice(savedLocation(full), 'zh-CN').prefs.getLocation(), full)
    assert.equal(slice(savedLocation({ region: 'CN' }), 'zh-CN').prefs.getLocation(), null)
    assert.equal(slice(savedLocation({ region: 'JP' }), 'zh-CN').prefs.getLocation(), null)
  })

  it('country mode keeps only the region', () => {
    const cn = savedLocation({ region: 'CN', province: GUANGDONG, city: GUANGZHOU })
    assert.deepEqual(slice(cn, 'en-US').prefs.getLocation(), { region: 'CN' })
    assert.deepEqual(slice(savedLocation({ region: 'JP' }), 'en-US').prefs.getLocation(), {
      region: 'JP',
    })
  })
})

describe('preferences: location validity', () => {
  it('loads unreadable or invalid saved values as no location', () => {
    assert.equal(slice({ [LOCATION]: '{not json' }).prefs.getLocation(), null)
    assert.equal(slice(savedLocation({ region: 'XX' })).prefs.getLocation(), null)
    assert.equal(slice(savedLocation(['CN'])).prefs.getLocation(), null)
    // A city that belongs to another province.
    const mismatched = savedLocation({ region: 'CN', province: GUANGDONG, city: BEIJING_CITY })
    assert.equal(slice(mismatched, 'zh-CN').prefs.getLocation(), null)
  })

  it('saves a valid location as JSON and notifies', () => {
    const { prefs, store } = slice({}, 'zh-CN')
    let notified = 0
    prefs.subscribe(() => (notified += 1))

    prefs.setLocation({ region: 'CN', province: GUANGDONG })

    assert.deepEqual(JSON.parse(store.get(LOCATION) ?? 'null'), {
      region: 'CN',
      province: GUANGDONG,
    })
    assert.equal(notified, 1)
  })

  it('drops extra fields of a non-CN location when saving', () => {
    const { prefs, store } = slice()
    prefs.setLocation({ region: 'JP', province: GUANGDONG })
    assert.deepEqual(prefs.getLocation(), { region: 'JP' })
    assert.equal(store.get(LOCATION), '{"region":"JP"}')
  })

  it('clears the saved location for null or an invalid value', () => {
    const { prefs, store } = slice(savedLocation({ region: 'JP' }))
    prefs.setLocation({ region: 'XX' })
    assert.equal(prefs.getLocation(), null)
    assert.equal(store.get(LOCATION), null)
  })
})

describe('preferences: location label', () => {
  const labelOf = (location: unknown, locale: 'zh-CN' | 'en-US', browser = 'zh-CN') =>
    slice(savedLocation(location), browser).prefs.getLocationLabel(locale)

  it('names the city, else the province, in Chinese for CN', () => {
    assert.equal(labelOf({ region: 'CN', province: GUANGDONG, city: GUANGZHOU }, 'zh-CN'), '广州市')
    assert.equal(labelOf({ region: 'CN', province: GUANGDONG }, 'zh-CN'), '广东省')
  })

  it('names the country in the locale otherwise', () => {
    assert.equal(labelOf({ region: 'CN', province: GUANGDONG }, 'en-US'), 'China')
    assert.equal(labelOf({ region: 'JP' }, 'en-US', 'en-US'), 'Japan')
    assert.equal(labelOf({ region: 'JP' }, 'zh-CN', 'en-US'), '日本')
    // Fixed names override Intl for HK, MO, TW.
    assert.equal(labelOf({ region: 'HK' }, 'en-US', 'en-US'), 'Hong Kong, China')
  })

  it('is empty when no location is set', () => {
    assert.equal(slice().prefs.getLocationLabel('en-US'), '')
  })
})

describe('preferences: storage unavailable', () => {
  it('still changes values for the session when writes are dropped', () => {
    const dropping: KeyValueStore = { get: () => null, set: () => undefined }
    const prefs = createPreferencesSlice({ store: dropping, browserLanguage: 'en-US' })

    prefs.setThemePreference('light')
    prefs.setLocation({ region: 'JP' })

    assert.equal(prefs.getThemePreference(), 'light')
    assert.deepEqual(prefs.getLocation(), { region: 'JP' })
  })
})
