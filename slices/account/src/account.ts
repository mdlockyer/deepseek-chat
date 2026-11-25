import type { HttpFetch, KeyValueStore, SecretSlot } from '@deepseek-chat/spine/ports'

/** Outcome of verifying a DeepSeek API key against `/models`. */
export type KeyCheck =
  | { readonly kind: 'valid' }
  | { readonly kind: 'invalid' }
  | { readonly kind: 'unreachable' }
  | { readonly kind: 'failed'; readonly message: string }

/** Storage key kept from the original app so saved keys survive the upgrade. */
const STORAGE_KEY = 'chat-demo:api-key'

export type AccountState =
  | { readonly status: 'loading' }
  | { readonly status: 'ready'; readonly apiKey: string | null }

export type AccountParams = { verifyTimeoutMs: number }

export const DEFAULT_ACCOUNT_PARAMS: AccountParams = { verifyTimeoutMs: 15_000 }

export type AccountDeps = {
  readonly store: KeyValueStore
  /** Desktop private storage; `null` keeps the key in web storage. */
  readonly secret: SecretSlot | null
  readonly fetch: HttpFetch
  /** DeepSeek API origin, e.g. https://api.deepseek.com */
  readonly apiOrigin: string
  readonly params?: Partial<AccountParams>
}

const clean = (key: string | null) => key?.trim() || null

/** Sends one GET with a timeout and maps the outcome to a KeyCheck. */
const checkKey = async (
  fetch: HttpFetch,
  url: string,
  apiKey: string,
  timeoutMs: number,
  signal?: AbortSignal
): Promise<KeyCheck> => {
  const controller = new AbortController()
  const onAbort = () => controller.abort(signal?.reason)
  if (signal?.aborted) {
    controller.abort(signal.reason)
  } else {
    signal?.addEventListener('abort', onAbort, { once: true })
  }
  const timer = setTimeout(() => controller.abort(), timeoutMs)
  let response: Response
  try {
    response = await fetch(url, {
      method: 'GET',
      headers: { Authorization: `Bearer ${apiKey}` },
      signal: controller.signal,
    })
  } catch (error) {
    if (signal?.aborted) {
      throw error
    }
    return { kind: 'unreachable' }
  } finally {
    clearTimeout(timer)
    signal?.removeEventListener('abort', onAbort)
  }
  if (response.ok) {
    return { kind: 'valid' }
  }
  if (response.status === 401) {
    return { kind: 'invalid' }
  }
  const text = await response.text().catch(() => '')
  let message = text || response.statusText
  try {
    const body = JSON.parse(text) as { error?: unknown }
    const error = body.error
    if (typeof error === 'string') {
      message = error
    } else if (
      typeof error === 'object' &&
      error !== null &&
      typeof (error as { message?: unknown }).message === 'string'
    ) {
      message = (error as { message: string }).message
    }
  } catch {
    // 非 JSON 响应体直接展示原文
  }
  return { kind: 'failed', message }
}

export const createAccount = (deps: AccountDeps) => {
  const params = { ...DEFAULT_ACCOUNT_PARAMS, ...deps.params }
  const { store, secret } = deps
  let state: AccountState = secret
    ? { status: 'loading' }
    : { status: 'ready', apiKey: clean(store.get(STORAGE_KEY)) }
  const listeners = new Set<() => void>()

  const setState = (next: AccountState) => {
    state = next
    for (const listener of [...listeners]) {
      listener()
    }
  }

  let hydration: Promise<void> | null = null
  /** Saves started so far; a save during hydration cancels the legacy migration. */
  let saves = 0
  const hydrate = (): Promise<void> => {
    if (!secret) {
      return Promise.resolve()
    }
    hydration ??= (async () => {
      const savesBefore = saves
      let apiKey: string | null = null
      let readable = true
      try {
        apiKey = clean(await secret.load())
      } catch {
        // 读不到不等于没有：不迁移，旧副本留待下次启动。
        readable = false
      }
      try {
        const legacy = clean(store.get(STORAGE_KEY))
        // 载入期间用户保存过密钥时不迁移也不删除旧副本：旧密钥不能覆盖新密钥，而新密钥可能
        // 没有保存成功；下次启动读到新密钥后再删除旧副本。
        if (readable && legacy && saves === savesBefore) {
          if (!apiKey) {
            await secret.save(legacy)
            apiKey = legacy
          }
          store.set(STORAGE_KEY, null)
        }
      } catch {
        // 存储不可用时按未设置处理，用户可在设置中重新输入。
        apiKey = null
      }
      // A key saved through setApiKey while hydrating wins over what was read.
      if (state.status === 'loading') {
        setState({ status: 'ready', apiKey })
      }
    })()
    return hydration
  }

  const setApiKey = async (key: string | null): Promise<void> => {
    const apiKey = clean(key)
    saves += 1
    if (secret) {
      await secret.save(apiKey)
    } else {
      store.set(STORAGE_KEY, apiKey)
    }
    setState({ status: 'ready', apiKey })
  }

  const verifyKey = (key: string, signal?: AbortSignal): Promise<KeyCheck> =>
    checkKey(deps.fetch, `${deps.apiOrigin}/models`, key.trim(), params.verifyTimeoutMs, signal)

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
    verifyKey,
    storage: secret ? ('device' as const) : ('browser' as const),
  }
}

export type Account = ReturnType<typeof createAccount>
