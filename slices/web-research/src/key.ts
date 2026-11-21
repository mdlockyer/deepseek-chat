import type { KeyValueStore, SecretSlot } from '@deepseek-chat/spine/ports'

/** Storage key kept from the original app so saved keys survive the upgrade. */
const STORAGE_KEY = 'chat-demo:firecrawl-api-key'

export type FirecrawlKeyState =
  | { readonly status: 'loading' }
  | { readonly status: 'ready'; readonly apiKey: string | null }

const clean = (key: string | null) => key?.trim() || null

/**
 * The user's optional Firecrawl key: web storage on the web, the desktop host's private storage
 * on desktop (migrating a legacy web-storage copy). Mirrors slices/account's rules on purpose:
 * duplicated locally rather than shared through the spine.
 */
export const createKeyStore = ({
  store,
  secret,
}: {
  store: KeyValueStore
  secret: SecretSlot | null
}) => {
  let state: FirecrawlKeyState = secret
    ? { status: 'loading' }
    : { status: 'ready', apiKey: clean(store.get(STORAGE_KEY)) }
  const listeners = new Set<() => void>()

  const setState = (next: FirecrawlKeyState) => {
    state = next
    for (const listener of [...listeners]) {
      listener()
    }
  }

  let hydration: Promise<void> | null = null
  const hydrate = (): Promise<void> => {
    if (!secret) {
      return Promise.resolve()
    }
    hydration ??= (async () => {
      let apiKey: string | null = null
      try {
        apiKey = clean(await secret.load().catch(() => null))
        const legacy = clean(store.get(STORAGE_KEY))
        if (!apiKey && legacy) {
          await secret.save(legacy)
          apiKey = legacy
        }
        if (legacy) {
          store.set(STORAGE_KEY, null)
        }
      } catch {
        apiKey = null
      }
      if (state.status === 'loading') {
        setState({ status: 'ready', apiKey })
      }
    })()
    return hydration
  }

  const setApiKey = async (key: string | null): Promise<void> => {
    const apiKey = clean(key)
    if (secret) {
      await secret.save(apiKey)
    } else {
      store.set(STORAGE_KEY, apiKey)
    }
    setState({ status: 'ready', apiKey })
  }

  return {
    getState: () => state,
    getApiKey: () => (state.status === 'ready' ? state.apiKey : null),
    subscribe: (listener: () => void) => {
      listeners.add(listener)
      return () => {
        listeners.delete(listener)
      }
    },
    hydrate,
    setApiKey,
  }
}

export type KeyStore = ReturnType<typeof createKeyStore>
