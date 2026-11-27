import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import type { SecretSlot } from '@deepseek-chat/spine/ports'
import { memoryStore } from '@deepseek-chat/test-support'
import { createAccountSlice, type AccountDeps } from '@deepseek-chat/slice-account'

const KEY = 'chat-demo:api-key'

/** Desktop secret slot double: holds one value, can be told to fail. */
const fakeSecret = (initial: string | null = null) => {
  let value = initial
  const saves: (string | null)[] = []
  let failSave = false
  let gate: Promise<void> = Promise.resolve()
  const slot: SecretSlot = {
    load: async () => {
      // Snapshot at call time, as a native read would; the gate only delays the answer.
      const read = value
      await gate
      return read
    },
    save: async (next) => {
      if (failSave) {
        throw new Error('keychain locked')
      }
      saves.push(next)
      value = next
    },
  }
  return {
    slot,
    saves,
    value: () => value,
    failSaves: () => {
      failSave = true
    },
    holdLoad: () => {
      let release: () => void = () => undefined
      gate = new Promise<void>((resolve) => {
        release = resolve
      })
      return release
    },
  }
}

const deps = (overrides: Partial<AccountDeps> = {}): AccountDeps => ({
  store: memoryStore(),
  secret: null,
  fetch: async () => new Response('{}'),
  apiOrigin: 'https://api.test',
  ...overrides,
})

describe('account: web storage', () => {
  it('is ready at once with the stored key, trimmed', () => {
    const account = createAccountSlice(deps({ store: memoryStore({ [KEY]: '  sk-web  ' }) }))
    assert.deepEqual(account.getState(), { status: 'ready', apiKey: 'sk-web' })
    assert.equal(account.getApiKey(), 'sk-web')
  })

  it('treats a blank stored key as none', () => {
    const account = createAccountSlice(deps({ store: memoryStore({ [KEY]: '   ' }) }))
    assert.equal(account.getApiKey(), null)
  })

  it('saves and removes the key under the original storage key', async () => {
    const store = memoryStore()
    const account = createAccountSlice(deps({ store }))

    await account.setApiKey(' sk-new ')
    assert.equal(store.get(KEY), 'sk-new')
    assert.equal(account.getApiKey(), 'sk-new')

    await account.setApiKey('  ')
    assert.equal(store.get(KEY), null)
    assert.equal(account.getApiKey(), null)
  })

  it('notifies subscribers on change', async () => {
    const account = createAccountSlice(deps())
    const seen: unknown[] = []
    account.subscribe(() => seen.push(account.getState()))

    await account.setApiKey('sk-1')

    assert.deepEqual(seen, [{ status: 'ready', apiKey: 'sk-1' }])
  })
})

describe('account: desktop storage', () => {
  it('is loading, with no key, until hydrated', async () => {
    const secret = fakeSecret('sk-desk')
    const account = createAccountSlice(deps({ secret: secret.slot }))

    assert.deepEqual(account.getState(), { status: 'loading' })
    assert.equal(account.getApiKey(), null)

    await account.hydrate()
    assert.deepEqual(account.getState(), { status: 'ready', apiKey: 'sk-desk' })
  })

  it('migrates a legacy web key into the empty slot and removes it from web storage', async () => {
    const store = memoryStore({ [KEY]: 'sk-legacy' })
    const secret = fakeSecret(null)
    const account = createAccountSlice(deps({ store, secret: secret.slot }))

    await account.hydrate()

    assert.equal(secret.value(), 'sk-legacy')
    assert.equal(store.get(KEY), null)
    assert.equal(account.getApiKey(), 'sk-legacy')
  })

  it('keeps the slot key over a legacy one and still removes the legacy copy', async () => {
    const store = memoryStore({ [KEY]: 'sk-legacy' })
    const secret = fakeSecret('sk-slot')
    const account = createAccountSlice(deps({ store, secret: secret.slot }))

    await account.hydrate()

    assert.equal(account.getApiKey(), 'sk-slot')
    assert.deepEqual(secret.saves, [], 'slot not overwritten')
    assert.equal(store.get(KEY), null)
  })

  it('becomes ready without a key when migration fails, leaving the legacy key in place', async () => {
    const store = memoryStore({ [KEY]: 'sk-legacy' })
    const secret = fakeSecret(null)
    secret.failSaves()
    const account = createAccountSlice(deps({ store, secret: secret.slot }))

    await account.hydrate()

    assert.deepEqual(account.getState(), { status: 'ready', apiKey: null })
    assert.equal(store.get(KEY), 'sk-legacy', 'not lost; retried next launch')
  })

  it('saves to the slot, never to web storage', async () => {
    const store = memoryStore()
    const secret = fakeSecret(null)
    const account = createAccountSlice(deps({ store, secret: secret.slot }))
    await account.hydrate()

    await account.setApiKey('sk-2')

    assert.equal(secret.value(), 'sk-2')
    assert.equal(store.get(KEY), null)
  })

  it('rejects and keeps the old state when the slot cannot be written', async () => {
    const secret = fakeSecret('sk-old')
    const account = createAccountSlice(deps({ secret: secret.slot }))
    await account.hydrate()
    secret.failSaves()

    await assert.rejects(() => account.setApiKey('sk-new'), /keychain locked/)
    assert.equal(account.getApiKey(), 'sk-old')
  })

  it('lets a key saved during hydration win over the one being read', async () => {
    const secret = fakeSecret('sk-read')
    const release = secret.holdLoad()
    const account = createAccountSlice(deps({ secret: secret.slot }))

    const hydrating = account.hydrate()
    await account.setApiKey('sk-typed')
    release()
    await hydrating

    assert.equal(account.getApiKey(), 'sk-typed')
  })
})

describe('account: key verification', () => {
  const verifying = (respond: () => Response | Promise<Response>, timeoutMs?: number) => {
    const calls: { url: string; init: RequestInit }[] = []
    const account = createAccountSlice(
      deps({
        fetch: async (url, init) => {
          calls.push({ url, init })
          return respond()
        },
        ...(timeoutMs ? { params: { verifyTimeoutMs: timeoutMs } } : {}),
      })
    )
    return { account, calls }
  }

  it('checks GET /models with the trimmed key as a Bearer token', async () => {
    const { account, calls } = verifying(() => new Response('{"data":[]}'))

    assert.deepEqual(await account.verifyKey('  sk-x  '), { kind: 'valid' })
    assert.equal(calls[0]?.url, 'https://api.test/models')
    assert.equal(calls[0]?.init.method, 'GET')
    assert.equal(new Headers(calls[0]?.init.headers).get('Authorization'), 'Bearer sk-x')
  })

  it('maps 401 to invalid and other HTTP errors to failed with the server message', async () => {
    const invalid = verifying(
      () => new Response('{"error":{"message":"bad key"}}', { status: 401 })
    )
    const failed = verifying(
      () => new Response('{"error":{"message":"service paused"}}', { status: 503 })
    )
    const plain = verifying(() => new Response('gateway down', { status: 502 }))

    assert.deepEqual(await invalid.account.verifyKey('k'), { kind: 'invalid' })
    assert.deepEqual(await failed.account.verifyKey('k'), {
      kind: 'failed',
      message: 'service paused',
    })
    assert.deepEqual(await plain.account.verifyKey('k'), {
      kind: 'failed',
      message: 'gateway down',
    })
  })

  it('maps no response and a timeout to unreachable', async () => {
    const offline = verifying(() => {
      throw new TypeError('Failed to fetch')
    })
    const hanging = createAccountSlice(
      deps({
        fetch: (_url, init) =>
          new Promise((_resolve, reject) =>
            init.signal?.addEventListener('abort', () =>
              reject(new DOMException('Aborted', 'AbortError'))
            )
          ),
        params: { verifyTimeoutMs: 5 },
      })
    )

    assert.deepEqual(await offline.account.verifyKey('k'), { kind: 'unreachable' })
    assert.deepEqual(await hanging.verifyKey('k'), { kind: 'unreachable' })
  })
})

describe('account: desktop migration never overwrites a newer or unreadable key', () => {
  /** A slot whose reads wait for `release()`; `failLoad` makes the read fail. */
  const slotWith = (initial: string | null, options: { failLoad?: boolean } = {}) => {
    let value = initial
    let release: () => void = () => undefined
    const gate = new Promise<void>((resolve) => (release = resolve))
    const slot: SecretSlot = {
      load: async () => {
        const read = value
        await gate
        if (options.failLoad) {
          throw new Error('keychain busy')
        }
        return read
      },
      save: async (next) => {
        value = next
      },
    }
    return { slot, release, value: () => value }
  }

  it('keeps a key saved while a legacy key was being migrated, in the state and the slot', async () => {
    const secret = slotWith(null)
    const store = memoryStore({ [KEY]: 'sk-legacy' })
    const account = createAccountSlice(deps({ store, secret: secret.slot }))
    const hydrating = account.hydrate()
    await account.setApiKey('sk-typed')
    secret.release()
    await hydrating
    assert.equal(account.getApiKey(), 'sk-typed')
    assert.equal(secret.value(), 'sk-typed', 'the next launch reads the typed key')
    // The legacy copy waits for the next launch, which reads the saved key and removes it.
    assert.equal(store.get(KEY), 'sk-legacy')
    const nextLaunch = createAccountSlice(
      deps({ store, secret: { load: async () => secret.value(), save: async () => undefined } })
    )
    await nextLaunch.hydrate()
    assert.equal(nextLaunch.getApiKey(), 'sk-typed')
    assert.equal(store.get(KEY), null, 'no key stays in web storage after that')
  })

  it('does not migrate over a slot it could not read, and keeps the legacy copy', async () => {
    const secret = slotWith('sk-stored', { failLoad: true })
    const store = memoryStore({ [KEY]: 'sk-legacy' })
    const account = createAccountSlice(deps({ store, secret: secret.slot }))
    secret.release()
    await account.hydrate()
    // SPEC 3: a failed read leaves the app ready without a key.
    assert.deepEqual(account.getState(), { status: 'ready', apiKey: null })
    assert.equal(secret.value(), 'sk-stored', 'the stored key is untouched')
    assert.equal(store.get(KEY), 'sk-legacy', 'the legacy copy stays for the next launch')
  })
})

it('account: a save that fails during migration loses no key', async () => {
  let value: string | null = null
  let release: () => void = () => undefined
  const gate = new Promise<void>((resolve) => (release = resolve))
  const store = memoryStore({ [KEY]: 'sk-legacy' })
  const account = createAccountSlice(
    deps({
      store,
      secret: {
        load: async () => {
          const read = value
          await gate
          return read
        },
        save: async (next) => {
          if (next === 'sk-typed') {
            throw new Error('keychain locked')
          }
          value = next
        },
      },
    })
  )
  const hydrating = account.hydrate()
  await assert.rejects(() => account.setApiKey('sk-typed'), /keychain locked/)
  release()
  await hydrating
  // The legacy key is still somewhere the next launch can find it.
  assert.ok(value === 'sk-legacy' || store.get(KEY) === 'sk-legacy')
})
