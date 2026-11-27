# SPEC: `slices/web-research` (live web search and page reading)

## Purpose

Provides `web_search` (Firecrawl v2), `web_scrape` (injected local desktop scraper or Firecrawl v2),
and the `research` subagent profile. Supports keyless Firecrawl or a user-provided API key behind
one shared rate limiter, concurrency cap, and per-reply credit budget.

## Public entrypoint

`createWebResearchSlice({ fetch, store, secret, localScrape?, params? })` returns:

| Member                                                                         | Meaning                                                                                                                   |
| :----------------------------------------------------------------------------- | :------------------------------------------------------------------------------------------------------------------------ |
| `toolNames`                                                                    | `{ search: 'web_search', scrape: 'web_scrape', research: 'research' }`. Persisted in history; never rename.               |
| `declareTools({ searchEnabled, questionText })`, `handles(name)`               | Tool declaration (invariant 1) and direct-call ownership (`web_search`, `web_scrape`).                                    |
| `instructions`, `instructionsFor(audience, declaredNames?)`                    | Static prompt section worded for `reply` or `agent` callers, interpolating configured parameters and scrape mode.         |
| `researchProfile`, `capability`                                                | Clean-context `research` profile (`finish_research`) and `ToolCapability` (`chat-demo:search`, presenter, archive codec). |
| `run(name, input, { signal, inputJson?, citedUrls?, caller?, replyKey? })`     | Runs one call through limiter and credit budget; always resolves to `WebToolResult`.                                      |
| `verifyKey`, `getApiKey`, `getKeyState`, `useKeyState`, `hydrate`, `setApiKey` | Keyless/keyed state, desktop secret hydration & legacy migration, credit-free verification.                               |
| `useKeyEditor()`, `KeySettings({ editor })`, `dispose()`                       | Settings UI (verifies before saving) and cache/listener teardown.                                                         |

## Behavioural invariants

1. **Declaration.** Search on → `web_search`, `web_scrape`, `research`. Search off + `http(s)://`
   URL in question → `web_scrape` only. Otherwise → none.
2. **Auth.** Non-blank key sends `Authorization: Bearer <trimmed key>` (read live per call); blank
   sends no `Authorization` header.
3. **Run never throws.** Returns `{ status: 'ok' | 'error' | 'aborted', content, ... }`: blank
   query/url → `Invalid input:` quoting raw input; non-http(s) URL → `Invalid URL:` without network
   I/O; caller abort → `aborted` (`Aborted by user.`).
4. **Mode-aware HTTP errors.** 429 distinguishes keyless daily limit from keyed rate/credit limit;
   401 reports invalid key.
5. **Search normalization & citations.** Keeps only `http(s)` URLs deduplicated in API order (web
   then news), title falls back to URL, snippet falls back `description -> snippet -> highlights`,
   `siteName` strips `www.`. `limit` clamps to `1–10`; empty results return `ok` with no sources.
   Reply citations reuse existing URL numbers in `citedUrls` and assign new URLs from `size + 1`.
6. **Scrape routing & truncation.** With `localScrape`, `web_scrape` runs locally under
   `maxLocalScrapeConcurrency` (0 Firecrawl credits, supporting `markdown-negotiated | http | pdf |
webview`); without it, uses Firecrawl `/v2/scrape` (empty body + HTTP `>= 400` is an error).
   Empty readable markdown renders `[No readable text content extracted from this page.]`. Text over
   `maxToolTextChars` cuts with `[Truncated after N characters]`.
7. **Key verification & storage.** Verification spends zero credits (`valid | invalid | unreachable
| failed`). Web uses `chat-demo:firecrawl-api-key` immediately; desktop starts `loading` until
   `hydrate()`, migrating an empty slot from web storage and deleting the legacy copy unless slot
   read/write fails or a concurrent save wins. Saving writes storage before updating state; Settings
   never saves an unverified key.
8. **Research profile & deterministic quote verification.** Uses active provider's default model
   unless overridden, thinking on, `context: 'clean'`, read-only `web_search` + `web_scrape`, and
   rejects blank `objective`. Agent scrapes cache `(title, markdown)` under `runId`; `complete`
   marks a source `verified` iff its non-empty quote matches verbatim (after whitespace normalization
   or inline Markdown stripping, with `...`/`…` spans appearing in order), then drops `runId`'s
   cache.
9. **Shared limiter, retries, credits, & scrape coalescing.** Firecrawl calls (2 credits/10 search
   results, 1/scrape) enforce sliding-window rate, `maxConcurrentRequests`, and `maxCreditsPerReply`
   before hitting the network. Keyed transient 429s (excluding permanent quota messages) retry up to
   `max429Retries` via `Retry-After` or exponential backoff while pausing queued siblings; keyless
   429s fail immediately; failed/aborted calls refund credits. Within a `replyKey`, completed
   scrapes are cached and concurrent identical-URL scrapes coalesce onto one request.
10. **Audience-aware wording.** Agent instructions interpolate live parameters, omit `[ref:n]` UI
    footers, and avoid Settings prompts on 401/429. Prompt wording reflects local vs Firecrawl
    scrape mode statically at creation.

## Facts

None consumed or published.

## Tunable parameters

| Parameter                                                      | Default                     | Meaning                                                                                      |
| :------------------------------------------------------------- | :-------------------------- | :------------------------------------------------------------------------------------------- |
| `searchTimeoutMs` / `scrapeTimeoutMs` / `verifyTimeoutMs`      | `30000` / `45000` / `15000` | Request timeouts (ms).                                                                       |
| `maxToolTextChars` / `defaultSearchLimit`                      | `24000` / `8`               | Output char cap and default result count.                                                    |
| `rateWindowMs` / `keylessRatePerMinute` / `keyedRatePerMinute` | `60000` / `10` / `20`       | Sliding window rate limits.                                                                  |
| `maxConcurrentRequests` / `maxLocalScrapeConcurrency`          | `3` / `6`                   | In-flight Firecrawl / local scrape caps.                                                     |
| `backoff429Ms` / `max429Retries` / `maxCreditsPerReply`        | `2000` / `3` / `120`        | Keyed 429 retry backoff and per-reply budget.                                                |
| `researchMaxRounds` / `researchMaxToolCalls`                   | `12` / `16`                 | Default `research` subagent limits (effort guidance: quick 2/2, standard 4/4, thorough 6/6). |
