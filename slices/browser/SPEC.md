# SPEC: `slices/browser` (built-in browser the user and the model share)

## Purpose

A real browser inside the desktop app: per-chat tabs shown in the right-hand panel, driven by the
user (address bar, tabs, history) and by the model through `browser_*` tools. Pages render in
native child webviews that the desktop host draws above the page; this slice decides when they are
visible and where. On the web build there is no host and the browser is unavailable.

## Public entrypoint

`createBrowserSlice({ log, host, panel, store, openExternal, notify?, newId? })` returns:

| Member                                                                             | Meaning                                                                                                                  |
| :--------------------------------------------------------------------------------- | :----------------------------------------------------------------------------------------------------------------------- |
| `available`                                                                        | `true` when a desktop host was given.                                                                                    |
| `capability`                                                                       | Open `ToolCapability` (`id: 'browser'`, owns `chat-demo:browser` toggle on desktop, `presenter`, `serializeForArchive`). |
| `declareTools({ enabled })`, `instructions`, `handles(name)`, `toolNames`          | Tool declaration for a turn (invariant 2). `toolNames` are persisted in chat history; never rename.                      |
| `HeaderToggle`                                                                     | Session header toggle button (renders only on desktop).                                                                  |
| `run(name, input, { signal, sessionId? })`                                         | Run one tool call. Always resolves to `{ status, text, images, meta, durationMs }`.                                      |
| `setActiveSession(id \| null)`                                                     | The chat on screen (`null`: the new-chat screen); also updated reactively by `ActiveSessionChanged`.                     |
| `start()`                                                                          | Bind host events; returns the unbinding function.                                                                        |
| `getSession(id)`                                                                   | `{ panelOpen, tabs, activeTabId }` for a chat.                                                                           |
| `openPanel(id?)`, `closePanel(id?)`, `togglePanel(id?)`                            | The browser panel of a chat (default: the active one).                                                                   |
| `openUrl(url, { sessionId?, newTab?, initiator? })`                                | Show a URL in the panel.                                                                                                 |
| `takeOver(sessionId)`                                                              | Publishes `BrowserControlTakenOver` so any controlling agent stops.                                                      |
| `tabs.create/close/switch/navigate/setViewport`, `setStageSize`, `setPanelBounds`  | Tab and layout operations (also used by the slice's own view).                                                           |
| `refreshSnapshot()`                                                                | Refresh the still image shown while the webview is hidden.                                                               |
| `BrowserPanel({ topActions? })`, `LocalhostSetting`                                | Views.                                                                                                                   |
| `isHttpUrl`, `normalizeOmniboxInput`, `computeSomBadgeBoxes`, `BROWSER_TOOL_NAMES` | Pure helpers, exported by the package.                                                                                   |
| `dispose()`                                                                        | Unsubscribes all Spine `EventLog` listeners.                                                                             |

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
6. **Overlay lock.** While `panel.getLayout().overlayLocked` is true the webview is hidden (capturing
   a still snapshot on the rising edge); clearing `overlayLocked` lets it show again.
7. **Panel replaced.** When the panel slot stops showing the browser for a chat, that chat's
   browser panel counts as closed.
8. **Lifecycle facts.** `ActiveSessionChanged` switches the active chat; `SessionDeleted` removes
   that chat's browser state and closes its native webviews; `SessionHistoryReplaced` does this for
   every chat. `takeOver(sessionId)` publishes `BrowserControlTakenOver`.
9. **URLs.** Only `http:`/`https:` are web pages. Address-bar input: explicit `http(s)://` kept;
   `localhost`/`127.0.0.1`/`[::1]` (with port/path) get `http://`; `name.tld` gets `https://`;
   anything else becomes a Google search; blank is `about:blank`.
10. **Tool runs & action settling.** Calls execute one at a time in call order. Tool calls politely
    reveal the browser panel (`panel.reveal`) rather than forcing it over another open workspace
    panel or a user dismissal, while still executing against the tab's webview in the background. A
    call aborted before it starts resolves `aborted` without touching the browser; a failure
    resolves `error` with the message; while a call runs the chat is marked as controlled by the
    model, and the mark is cleared afterwards. Actions that initiate a document navigation (`browser_navigate`,
    navigating `browser_click`, `browser_type` with `submit: true`, and form-submitting or
    link-activating `browser_press_key`) wait for the navigation to start and finish loading before
    snapshotting. `browser_type` with `submit: true` yields after input before dispatching `Enter`
    to the live active element (without a premature `change` event). `browser_click` and
    `browser_type` only `scrollIntoView` when targeting by `ref` (never shifting elements under
    explicit viewport `(x, y)` coordinates). `browser_press_key` executes standard keyboard default
    actions (`Tab`/`Shift+Tab` focus traversal, `Enter`/`Space` control activation, `Home`/`End`
    and page scrolling) when `keydown` is not prevented by the page. Detached element refs fail with
    `status: 'error'` (never silently retargeting another node) and include refreshed interactive
    refs (and matching replacement hints) wrapped in `<untrusted_webpage_content …>`.
11. **Untrusted content, iframes & snapshot verbosity.** Page text, refreshed stale-ref listings,
    cross-origin iframe listings, and `browser_eval` results reach the model wrapped in
    `<untrusted_webpage_content …>…</untrusted_webpage_content>`; truncation always occurs inside
    the wrapper so the closing tag is never dropped. Interactive element listings and `Page text:`
    are budgeted separately so link-dense pages never starve page text, truncated page text reports
    shown vs. total character counts with `selector`/`browser_eval` guidance, and capped element
    lists note that existing `[eN]` refs stay valid. Snapshot headers report CSS viewport pixels
    and, when a screenshot is attached, its encoded pixel dimensions and scale vs. the CSS viewport
    so coordinate clicks stay unambiguous on HiDPI displays and scaled viewports. Snapshots never
    include password field values, traverse accessible same-origin iframes into `[eN]` refs and
    page text, list visible cross-origin iframes (title and `src`) when present, index visible
    scrollable containers for `browser_scroll({ ref })` (excluded from screenshot SoM badges), and
    clear transient driver overlays (and hide the agent cursor) before capturing screenshots. Layout/chrome actions
    (`browser_scroll`, `browser_set_viewport`, `browser_tabs` switch) omit page text unless
    requested (`browser_scroll` with `ref` reports the container's updated scroll position);
    same-URL content-mutating actions (`browser_click`, `browser_type`, `browser_press_key`,
    `browser_select`) deduplicate unchanged page text across hash-only URL changes and report only
    changed lines (or full text when the page mostly changed); `browser_observe` and navigations
    return full page text unless `text: false`. `browser_tabs` `close` reports the newly active tab
    (or notes when no tabs remain).
12. **Agent cursor.** One small solid kite in the app's accent blue (white edge, tip on its point;
    `kiteCursor.ts`) shows what the model is doing, drawn inside the page (embedded in the driver
    scripts) and over the browser's toolbar in the app's window (`agentCursor.ts`), and moving
    between the two through the page's top edge. Before `browser_click`, `browser_type` and
    `browser_select` act it glides on a critically damped spring to the point the action will use
    (a ref's centre after it is scrolled into view, explicit `(x, y)`, or the focused element) and
    presses (scales to 0.84) as the action fires; `browser_press_key` takes it to the focused element
    (or leaves it where it is) and presses; `browser_scroll` keeps it where it is (or brings it to
    the middle of the page). `browser_navigate` takes it up out of the page to the address bar,
    which it presses and types the URL into (at most 450 ms) before loading, or to the back, forward
    or reload button; `browser_tabs` takes it to the new-tab button, the tab, or the tab's close
    button. It stays in the toolbar until the next page action brings it back down into the page.
    Actions wait for each glide (at most 700 ms in the page, 600 ms in the toolbar) only while that
    tab is the page on screen; off screen nothing waits and the toolbar part is skipped. A faint
    glow follows the kite's outline: almost none at rest, more as it moves faster, and a short bloom
    on each press; reduced motion makes it jump, with no glow and no typing. It takes no pointer
    events, lives in a closed shadow root in the page, carries over to the same spot after a page
    load, and is hidden while a screenshot is captured. It stays visible for the whole reply that
    drives the browser and fades out when that reply settles (`ReplyLifecycleChanged`), when the
    reader takes over, or when the reader uses the page or the app (a trusted pointer, key or wheel
    event). A target that cannot be resolved never blocks the action, which reports the error itself.
13. **Viewports** are per tab; the tab's zoom is the fit of its viewport into the stage.
14. **Localhost access.** Stored under `chat-demo:browser-allow-localhost` (default off) and sent to
    the host when events are bound and whenever it changes.
15. **New-chat screen links.** `openUrl` with no chat opens the URL externally.

## Tunable parameters

- Navigation settle delays: post-load SPA settle (~180 ms), post-type submit yield (~150 ms),
  non-navigating action settle (~180–250 ms), expected-navigation start window (~2,000 ms), and
  load timeout (~10,000–15,000 ms).
- Snapshot budgets: interactive element cap (140), scrollable container cap (8), cross-origin iframe
  listing cap (12), `<select>` option preview cap (20, always retaining selected option(s) with
  overflow count), extracted page text cap (12,000 chars), and outer tool output cap (24,000 chars,
  truncated inside `<untrusted_webpage_content>`).
- Agent cursor: 22 px kite, spring stiffness 170 /s², longest wait for it to land 700 ms in the
  page and 600 ms in the toolbar, address typing at most 450 ms, leaves the page 30 px above its
  top edge, press scale 0.84 for 120 ms, glow alpha 0.08 at rest rising to 0.42 at speed (900 px/s)
  plus up to 0.4 on a press (fading over 450 ms, capped at 0.6).
- Delta reporting threshold: same-URL diff emits changed lines when at most half the page changed
  and the delta fits within a compact cap; larger rewrites emit full page text.

## Facts

Consumes `ActiveSessionChanged`, `SessionDeleted`, `SessionHistoryReplaced`,
`ReplyLifecycleChanged` (hides the agent cursor when a reply settles). Publishes
`BrowserControlTakenOver`.

## Ownership notes

- The right-hand panel (which kind is shown per chat, width, animation, stage size) belongs to the
  app; this slice sees it only through its `PanelSlot`.
- The page-driver scripts (`driver.ts`) run inside web pages and are tested through `run`.
