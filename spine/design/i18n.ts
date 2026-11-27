import {
  createContext,
  createElement,
  useContext,
  useSyncExternalStore,
  type ReactNode,
} from 'react'

/**
 * Translation mechanism and factory-scoped UI locale store. Domain-blind: each slice (and the app)
 * owns its own catalogue and calls `defineMessages` with it; nothing here holds module-level
 * mutable locale state.
 */

export const LOCALES = ['zh-CN', 'en-US'] as const
export type Locale = (typeof LOCALES)[number]
export const DEFAULT_LOCALE: Locale = 'en-US'

export type MessageParams = Record<string, string | number>

/** One string per key for every locale. A missing key in any locale is a type error. */
export type Catalogues<Key extends string> = {
  readonly [L in Locale]: Readonly<Record<Key, string>>
}

export type Translate<Key extends string> = (key: Key, params?: MessageParams) => string

export type LocaleStore = {
  get(): Locale
  set(locale: Locale): void
  subscribe(listener: () => void): () => void
}

export const isLocale = (value: unknown): value is Locale =>
  typeof value === 'string' && (LOCALES as readonly string[]).includes(value)

/** Creates an isolated, instance-scoped locale store (zero process-wide singletons). */
export const createLocaleStore = (initial: Locale = DEFAULT_LOCALE): LocaleStore => {
  if (!isLocale(initial)) {
    throw new RangeError(`Unsupported locale: ${String(initial)}`)
  }
  let current: Locale = initial
  const listeners = new Set<() => void>()

  return {
    get: () => current,
    set: (locale) => {
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
    },
    subscribe: (listener) => {
      listeners.add(listener)
      return () => {
        listeners.delete(listener)
      }
    },
  }
}

const DEFAULT_LOCALE_STORE: LocaleStore = Object.freeze({
  get: () => DEFAULT_LOCALE,
  set: () => {
    throw new Error('Cannot mutate the default read-only LocaleStore; mount a <LocaleProvider>.')
  },
  subscribe: () => () => undefined,
})

const LocaleContext = createContext<LocaleStore>(DEFAULT_LOCALE_STORE)

export const LocaleProvider = ({
  store,
  children,
}: {
  readonly store: LocaleStore
  readonly children?: ReactNode
}) => createElement(LocaleContext.Provider, { value: store }, children)

export const useLocaleStore = (): LocaleStore => useContext(LocaleContext)

/** React: the active locale from the nearest `<LocaleProvider>`; re-renders on change. */
export const useLocale = (): Locale => {
  const store = useLocaleStore()
  return useSyncExternalStore(store.subscribe, store.get, store.get)
}

/** Replaces `{name}` with `params.name`; unknown placeholders are left as written. */
const format = (template: string, params?: MessageParams) =>
  template.replace(/\{(\w+)\}/g, (placeholder, name: string) => {
    const value = params?.[name]
    return typeof value === 'string' || typeof value === 'number' ? String(value) : placeholder
  })

export type Messages<Key extends string> = {
  /** Translates `key` in the explicit `locale` (defaults to `'en-US'` when omitted). */
  translate: (locale: Locale | undefined, key: Key, params?: MessageParams) => string
  /** Returns a locale-deferred thunk `(locale?) => string` for notices and toggle labels. */
  lazy: (key: Key, params?: MessageParams) => (locale?: Locale) => string
  /** React: a translate function bound to the nearest `<LocaleProvider>`; re-renders on change. */
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

  const translate = (locale: Locale | undefined, key: Key, params?: MessageParams) =>
    translators[locale ?? DEFAULT_LOCALE](key, params)

  return {
    translate,
    lazy:
      (key, params) =>
      (locale = DEFAULT_LOCALE) =>
        translators[locale](key, params),
    useTranslate: () => translators[useLocale()],
    has: (key): key is Key => typeof key === 'string' && Object.hasOwn(reference, key),
  }
}
