import { useSyncExternalStore } from 'react'
import { createAccount, type AccountDeps, type AccountState } from './account.js'
import { createKeySettings, createUseKeyEditor } from './KeySettings.js'

export type { AccountDeps, AccountParams, AccountState } from './account.js'
export type { KeyEditor } from './KeySettings.js'

export const createAccountSlice = (deps: AccountDeps) => {
  const account = createAccount(deps)
  return {
    getState: account.getState,
    subscribe: account.subscribe,
    /** React: the current account state. */
    useState: (): AccountState =>
      useSyncExternalStore(account.subscribe, account.getState, account.getState),
    getApiKey: account.getApiKey,
    hydrate: account.hydrate,
    setApiKey: account.setApiKey,
    verifyKey: account.verifyKey,
    useKeyEditor: createUseKeyEditor(account),
    KeySettings: createKeySettings(account),
  }
}

export type AccountSlice = ReturnType<typeof createAccountSlice>
