# SPEC: `slices/web-research` (live web search and page reading)

## Purpose

Gives the model two client tools backed by Firecrawl v2 — `web_search` (ranked results with
snippets) and `web_scrape` (one page as markdown) — plus the `research` deep-research subagent
profile. Works keyless (Firecrawl's free tier, limited per IP per day) or with the user's Firecrawl
API key, with one shared rate limiter and per-reply credit budget.

## Public entrypoint

`createWebResearchSlice({ fetch, store, secret, params? })` returns:

| Member                                                                     | Meaning                                                                                                         |
| :------------------------------------------------------------------------- | :-------------------------------------------------------------------------------------------------------------- |
| `toolNames`                                                                | `{ search: 'web_search', scrape: 'web_scrape', research: 'research' }`. Persisted in history; never rename.     |
| `declareTools({ searchEnabled, questionText })`                            | Tools to declare for a turn (see invariant 1).                                                                  |
| `instructions` / `instructionsFor(audience, declaredNames?)`               | System-prompt section worded for `reply` or `agent` callers, interpolating configured parameters.               |
| `researchProfile`                                                          | Clean-context subagent profile (`deepseek-flash`, thinking on, `web_search` + `web_scrape`, `finish_research`). |
| `handles(name)`                                                            | Whether a direct tool call belongs to this slice (`web_search`, `web_scrape`).                                  |
| `run(name, input, { signal, inputJson?, citedUrls?, caller?, replyKey? })` | Run one call through the shared rate limiter and credit budget. Always resolves to a `WebToolResult`.           |
| `verifyKey(key, signal?)`                                                  | `{ kind: 'valid' } \| { kind: 'invalid' } \| { kind: 'unreachable' } \| { kind: 'failed', message }`.           |
| `getApiKey()`                                                              | The saved key, or `null` (keyless, or still loading on desktop).                                                |
| `getKeyState()` / `useKeyState()`                                          | `{ status: 'loading' }` or `{ status: 'ready', apiKey: string \| null }`.                                       |
| `hydrate()`                                                                | Desktop: read the key from the secret slot (migrating a legacy web-storage key). Web: no-op. Never rejects.     |
| `setApiKey(key \| null)`                                                   | Save (trimmed) or remove. Rejects if the desktop secret cannot be written; state unchanged then.                |
| `useKeyEditor()` + `KeySettings({ editor })`                               | Settings view; the editor hook keeps typed input across section switches.                                       |

The key is read on every call, so a key change applies to the next call.

## Behavioural invariants

1. **Declaration.** Search enabled → `web_search`, `web_scrape`, and `research`. Search disabled
   but the question contains an `http(s)://` URL → `web_scrape` only. Otherwise → none.
2. **Auth.** With a non-blank key every request carries `Authorization: Bearer <trimmed key>`;
   without one, no `Authorization` header is sent.
3. **Run never throws.** Every outcome is a `WebToolResult` with `status` `ok | error | aborted`:
   - invalid input (`query` missing/blank, `url` missing/blank) → `error`, content starts with
     `Invalid input:` and quotes the raw input;
   - a non-http(s) scrape URL → `error` (`Invalid URL: …`) without any request;
   - the caller's signal aborts → `aborted`, content `Aborted by user.`;
   - any other failure → `error` with a message the model can act on.
4. **Rate limits are explained by mode.** HTTP 429 without a key says the keyless daily limit was
   reached and suggests adding a key; with a key it says the rate/credit limit was reached. HTTP 401
   says the key is invalid.
5. **Search results.** Only `http(s)` URLs, deduplicated by URL, in API order (web then news). A
   missing title falls back to the URL; the snippet is `description`, else `snippet`, else joined
   `highlights`. `siteName` is the hostname without `www.`.
6. **Citation numbering continues within a reply.** Results are numbered `[n]` for the model. A URL
   already in `citedUrls` keeps its number; new URLs continue from `citedUrls.size + 1`. The text
   tells the model to cite as `[citation:n]`.
7. **Search limit** is clamped to 1–10 (default `defaultSearchLimit`). No results → `ok` with a
   "No search results found" message and no sources.
8. **Scrape.** Returns the final URL (`metadata.sourceURL` when it is http(s), else the requested
   URL) and title. A page with no markdown and `statusCode >= 400` is an `error`.
9. **Text limit.** Tool text longer than `maxToolTextChars` is cut and ends with
   `[Truncated after N characters]` (N formatted `en-US`, e.g. `24,000`).
10. **Key verification** uses an endpoint that spends no credits. 401 → `invalid`; no response
    (network, timeout) → `unreachable`; any other failure → `failed` with the server's message.
11. **Key storage.** Web: under `chat-demo:firecrawl-api-key` in `KeyValueStore`, `ready` at once.
    Desktop (`secret` given): `loading` (keyless) until `hydrate()` settles. If the slot is empty a
    legacy web key is copied into it; any legacy web copy is then removed. If that fails, or the
    slot cannot be read, the state becomes `ready` with no key and the legacy copy stays for the
    next launch. A key saved during hydration wins over the one being read, in the state and in
    the slot: no legacy key is copied over it, and the legacy copy stays until the next launch reads
    the saved key (the save may have failed). Saving writes storage first, then updates the state.
12. **Settings view** verifies before saving and never saves an unverified key.
13. **Research profile (`research`, `finish_research`).** Uses `deepseek-flash` with thinking on,
    `context: 'clean'`, and read-only tools `web_search` and `web_scrape`. `task(input)` rejects
    inputs without a non-blank `objective` and interpolates the configured tool-call budget.
14. **Deterministic quote verification and page cache.** When `web_scrape` succeeds for an `agent`
    caller, the page's markdown is cached under that caller's `runId`. `complete` marks each source
    `verified` if and only if its non-empty `quote`, normalized for whitespace, appears in a page
    scraped under that `runId`, and `unverified` otherwise. The `runId`'s page cache is dropped when
    `complete` finishes.
15. **Shared rate limiter and credit budget.** Every Firecrawl search (2 credits per 10 results) and
    scrape (1 credit) passes through one sliding-window limiter enforcing the per-minute rate for
    the current key mode, backing off subsequent calls on HTTP 429, and refusing calls once
    `maxCreditsPerReply` is reached for a reply without sending a request.
16. **Audience-aware wording.** For `agent` callers, `instructionsFor('agent')` interpolates the
    slice's live parameters (`defaultSearchLimit`, `maxToolTextChars`, `scrapeTimeoutMs`), search
    results omit the `[citation:n]` UI footer, and 401/429 errors do not ask the agent to open
    Settings.

## Facts

None consumed or published.

## Tunable parameters

| Parameter              | Default | Meaning                                                 |
| :--------------------- | :------ | :------------------------------------------------------ |
| `searchTimeoutMs`      | `30000` | Timeout for `/search`.                                  |
| `scrapeTimeoutMs`      | `45000` | Timeout for `/scrape`.                                  |
| `verifyTimeoutMs`      | `15000` | Timeout for key verification.                           |
| `maxToolTextChars`     | `24000` | Characters of tool text returned to the model.          |
| `defaultSearchLimit`   | `8`     | Results when the model gives no `limit`.                |
| `rateWindowMs`         | `60000` | Sliding rate-limiter window length (ms).                |
| `keylessRatePerMinute` | `10`    | Max requests per window without a Firecrawl API key.    |
| `keyedRatePerMinute`   | `30`    | Max requests per window with a Firecrawl API key.       |
| `backoff429Ms`         | `2000`  | Pause applied to subsequent calls after HTTP 429 (ms).  |
| `maxCreditsPerReply`   | `120`   | Firecrawl credit budget per reply (2/search, 1/scrape). |
| `researchMaxRounds`    | `12`    | Max model rounds per `research` subagent run.           |
| `researchMaxToolCalls` | `16`    | Max tool calls per `research` subagent run.             |

## Ownership notes

- Key storage deliberately duplicates `slices/account`'s rules rather than sharing them through
  the spine.
