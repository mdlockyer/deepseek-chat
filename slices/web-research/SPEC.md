# SPEC: `slices/web-research` (live web search and page reading)

## Purpose

Gives the model two client tools backed by Firecrawl v2: `web_search` (ranked results with
snippets) and `web_scrape` (one page as markdown). Works keyless (Firecrawl's free tier, limited per
IP per day) or with the user's Firecrawl API key.

## Public entrypoint

`createWebResearchSlice({ fetch, apiKey, params? })` returns:

| Member                                                 | Meaning                                                                                               |
| :----------------------------------------------------- | :---------------------------------------------------------------------------------------------------- |
| `toolNames`                                            | `{ search: 'web_search', scrape: 'web_scrape' }`. Persisted in chat history; never rename.            |
| `declareTools({ searchEnabled, questionText })`        | Tools to declare for a turn (see invariant 1).                                                        |
| `instructions`                                         | System-prompt section to include whenever any web tool is declared.                                   |
| `handles(name)`                                        | Whether a tool call belongs to this slice.                                                            |
| `run(name, input, { signal, inputJson?, citedUrls? })` | Run one call. Always resolves to a `WebToolResult`.                                                   |
| `verifyKey(key, signal?)`                              | `{ kind: 'valid' } \| { kind: 'invalid' } \| { kind: 'unreachable' } \| { kind: 'failed', message }`. |

`apiKey()` is read on every call, so a key change applies to the next call.

## Behavioural invariants

1. **Declaration.** Search enabled → both tools. Search disabled but the question contains an
   `http(s)://` URL → `web_scrape` only. Otherwise → none.
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

## Facts

None consumed or published.

## Tunable parameters

| Parameter            | Default | Meaning                                        |
| :------------------- | :------ | :--------------------------------------------- |
| `searchTimeoutMs`    | `30000` | Timeout for `/search`.                         |
| `scrapeTimeoutMs`    | `45000` | Timeout for `/scrape`.                         |
| `verifyTimeoutMs`    | `15000` | Timeout for key verification.                  |
| `maxToolTextChars`   | `24000` | Characters of tool text returned to the model. |
| `defaultSearchLimit` | `8`     | Results when the model gives no `limit`.       |

## Ownership notes

- The Firecrawl key's storage and settings UI still live in `src/services/settings.ts` and
  `src/components/settings/ApiKeyField.tsx`; they move here when settings are split per slice.
