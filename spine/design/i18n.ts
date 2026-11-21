import { useSyncExternalStore } from 'react'

/**
 * Translation mechanism and the current UI locale. Domain-blind: each slice (and the app) owns
 * its own catalogue and calls `defineMessages` with it; nothing here knows any message.
 *
 * Who persists the user's choice is not this module's concern; the owner calls `setLocale`.
 */

export const LOCALES = ['zh-CN', 'en-US'] as const
export type Locale = (typeof LOCALES)[number]

export type MessageParams = Record<string, string | number>

/** One string per key for every locale. A missing key in any locale is a type error. */
export type Catalogues<Key extends string> = {
  readonly [L in Locale]: Readonly<Record<Key, string>>
}

export type Translate<Key extends string> = (key: Key, params?: MessageParams) => string

let current: Locale = 'en-US'
const listeners = new Set<() => void>()

export const isLocale = (value: unknown): value is Locale =>
  typeof value === 'string' && (LOCALES as readonly string[]).includes(value)

export const getLocale = (): Locale => current

export const setLocale = (locale: Locale) => {
  if (!isLocale(locale)) {
    throw new RangeError(`Unsupported locale: ${String(locale)}`)
  }
  if (locale === current) {
    return
  }
  current = locale
  for (const listener of [...listeners]) {
    listener()
  }
}

/** Calls `listener` after every locale change; returns an unsubscribe function. */
export const subscribeLocale = (listener: () => void): (() => void) => {
  listeners.add(listener)
  return () => {
    listeners.delete(listener)
  }
}

/** React: the current locale; re-renders when it changes. */
export const useLocale = (): Locale => useSyncExternalStore(subscribeLocale, getLocale, getLocale)

/** Replaces `{name}` with `params.name`; unknown placeholders are left as written. */
const format = (template: string, params?: MessageParams) =>
  template.replace(/\{(\w+)\}/g, (placeholder, name: string) => {
    const value = params?.[name]
    return typeof value === 'string' || typeof value === 'number' ? String(value) : placeholder
  })

export type Messages<Key extends string> = {
  /** Translates with the locale current at call time. */
  translate: Translate<Key>
  /** React: a translate function bound to the current locale; re-renders on change. */
  useTranslate: () => Translate<Key>
  /** Whether `key` is a key of this catalogue. */
  has: (key: unknown) => key is Key
}

export const defineMessages = <Key extends string>(catalogues: Catalogues<Key>): Messages<Key> => {
  const translators = Object.fromEntries(
    LOCALES.map((locale) => {
      const table = catalogues[locale]
      const translate: Translate<Key> = (key, params) => format(table[key], params)
      return [locale, translate]
    })
  ) as Record<Locale, Translate<Key>>
  const reference = catalogues[LOCALES[0]]

  return {
    translate: (key, params) => translators[current](key, params),
    useTranslate: () => translators[useLocale()],
    has: (key): key is Key => typeof key === 'string' && Object.hasOwn(reference, key),
  }
}
