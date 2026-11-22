# SPEC: `slices/browser` (built-in browser the user and the model share)

## Purpose

A real browser inside the desktop app: per-chat tabs shown in the right-hand panel, driven by the
user (address bar, tabs, history) and by the model through `browser_*` tools. Pages render in
native child webviews that the desktop host draws above the page; this slice decides when they are
visible and where. On the web build there is no host and the browser is unavailable.

## Public entrypoint

`createBrowserSlice({ log, host, panel, store, openExternal, stopController, newId? })` returns:

| Member                                                                            | Meaning                                                                                             |
| :-------------------------------------------------------------------------------- | :-------------------------------------------------------------------------------------------------- |
| `available`                                                                       | `true` when a desktop host was given.                                                               |
| `declareTools({ enabled })`, `instructions`, `handles(name)`, `toolNames`         | Tool declaration for a turn (invariant 2). `toolNames` are persisted in chat history; never rename. |
| `run(name, input, { signal, sessionId? })`                                        | Run one tool call. Always resolves to `{ status, text, images, meta, durationMs }`.                 |
| `setActiveSession(id \| null)`                                                    | The chat on screen (`null`: the new-chat screen).                                                   |
| `start()`                                                                         | Bind host events; returns the unbinding function.                                                   |
| `getSession(id)`                                                                  | `{ panelOpen, tabs, activeTabId }` for a chat.                                                      |
| `openPanel(id?)`, `closePanel(id?)`, `togglePanel(id?)`                           | The browser panel of a chat (default: the active one).                                              |
| `openUrl(url, { sessionId?, newTab?, initiator? })`                               | Show a URL in the panel.                                                                            |
| `tabs.create/close/switch/navigate/setViewport`, `setStageSize`, `setPanelBounds` | Tab and layout operations (also used by the slice's own view).                                      |
| `acquireOverlayLock()`                                                            | Hide the native webview under an HTML overlay; returns the release.                                 |
| `refreshSnapshot()`                                                               | Refresh the still image shown while the webview is hidden.                                          |
| `BrowserPanel({ topActions? })`, `LocalhostSetting`                               | Views.                                                                                              |
| `isHttpUrl`, `normalizeOmniboxInput`, `BROWSER_TOOL_NAMES`                        | Pure helpers, exported by the package.                                                              |

Ports: `BrowserHost` (desktop IPC, `null` on web), `PanelSlot` (this slice's slot in the app's right
panel, from `spine/design`), `KeyValueStore`.

## Behavioural invariants

1. **Web build.** Without a host: `available` is false, no tools are declared, any `run` resolves to
   an error saying the browser is desktop-only, and the panel renders nothing.
2. **Declaration.** With a host and `enabled`, all eleven `browser_*` tools are declared; otherwise
   none.
3. **Per-chat ownership.** Tabs, the open/closed state and the active tab belong to one chat and
   never leak to another. On the new-chat screen the panel cannot open and tabs cannot be created.
4. **Tabs.** Opening a panel with no tabs creates a blank tab. Closing the active tab activates the
   tab that takes its place (or the previous one at the end). Closing the last tab closes the panel.
5. **Native visibility.** The active tab's webview is shown only when all hold: a chat is active,
   the panel slot shows the browser for that chat, the chat's browser panel is open, the panel is
   not animating or resizing, no overlay lock is held, and the tab shows an `http(s)` page whose
   webview exists. Otherwise the host is told to hide it.
6. **Overlay lock.** While any lock is held the webview is hidden; releasing the last lock lets it
   show again. Releasing twice has no extra effect.
7. **Panel replaced.** When the panel slot stops showing the browser for a chat, that chat's
   browser panel counts as closed.
8. **Lifecycle facts.** `SessionDeleted` removes that chat's browser state and closes its native
   webviews; `SessionHistoryReplaced` does this for every chat.
9. **URLs.** Only `http:`/`https:` are web pages. Address-bar input: explicit `http(s)://` kept;
   `localhost`/`127.0.0.1`/`[::1]` (with port/path) get `http://`; `name.tld` gets `https://`;
   anything else becomes a Google search; blank is `about:blank`.
10. **Tool runs** execute one at a time in call order. A call aborted before it starts resolves
    `aborted` without touching the browser; a failure resolves `error` with the message; while a
    call runs the chat is marked as controlled by the model, and the mark is cleared afterwards.
11. **Untrusted content.** Page text and `browser_eval` results reach the model wrapped in
    `<untrusted_webpage_content …>`. Snapshots never include password field values.
12. **Viewports** are per tab; the tab's zoom is the fit of its viewport into the stage.
13. **Localhost access.** Stored under `chat-demo:browser-allow-localhost` (default off) and sent to
    the host when events are bound and whenever it changes.
14. **New-chat screen links.** `openUrl` with no chat opens the URL externally.

## Facts

Consumes `SessionDeleted`, `SessionHistoryReplaced`. Publishes none.

## Ownership notes

- The right-hand panel (which kind is shown per chat, width, animation, stage size) belongs to the
  app; this slice sees it only through its `PanelSlot`.
- The page-driver scripts (`driver.ts`) run inside web pages and are tested through `run`.
