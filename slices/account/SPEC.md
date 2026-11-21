# SPEC: `slices/account` (DeepSeek API key)

## Purpose

Owns the user's DeepSeek API key: where it is stored, whether it has been loaded, checking it
against the API, and the settings view for entering, testing and removing it. Every request to the
DeepSeek API (chat, uploads, speech) reads the key from here.

## Public entrypoint

`createAccountSlice({ store, secret, fetch, apiOrigin, params? })` returns:

| Member                                       | Meaning                                                                                                       |
| :------------------------------------------- | :------------------------------------------------------------------------------------------------------------ |
| `getState()` / `subscribe` / `useState()`    | `{ status: 'loading' }` or `{ status: 'ready', apiKey: string \| null }`.                                     |
| `getApiKey()`                                | The key, or `null` while loading or when none is saved.                                                       |
| `hydrate()`                                  | Desktop: read the key from the secret slot (and migrate a legacy web-storage key). Web: no-op. Never rejects. |
| `setApiKey(key \| null)`                     | Save (trimmed) or remove. Rejects if the desktop secret cannot be written; the state is unchanged then.       |
| `verifyKey(key, signal?)`                    | A `KeyCheck`: `valid`, `invalid`, `unreachable` or `failed(message)`. Spends nothing.                         |
| `useKeyEditor()` + `KeySettings({ editor })` | Settings view; the editor hook keeps typed input across section switches.                                     |

## Behavioural invariants

1. **Storage.** Web: the key lives in `KeyValueStore` under `chat-demo:api-key` and the state is
   `ready` immediately. Desktop (`secret` given): the state is `loading` until `hydrate()` settles.
2. **Desktop migration.** If the secret slot is empty and web storage holds a legacy key, the
   legacy key is copied into the slot. Any legacy key is then removed from web storage, so a key
   never stays in web storage on desktop.
3. **Hydration never blocks the app.** If reading or migrating fails, the state becomes `ready`
   with no key.
4. **Saving.** `setApiKey` writes to the desktop slot or web storage, then updates the state
   (which becomes `ready`). A blank key is treated as removal.
5. **Verification.** `GET {apiOrigin}/models` with `Authorization: Bearer <key>`. HTTP 401 →
   `invalid`; no response or timeout → `unreachable`; any other failure → `failed` with the
   server's message.
6. **Settings view** verifies before saving and never saves an unverified key.

## Facts

None. Consumers read the key top-down through `getApiKey()`.

## Tunable parameters

| Parameter         | Default | Meaning                  |
| :---------------- | :------ | :----------------------- |
| `verifyTimeoutMs` | `15000` | Timeout for `verifyKey`. |
