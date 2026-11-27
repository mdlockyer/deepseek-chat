# SPEC: `slices/browser` (built-in browser shared by user and model)

## Purpose

A desktop-only per-chat multi-tab browser hosted in the right-hand panel, driven by both the user
and the model via `browser_*` tools. Pages render in native child webviews positioned by the desktop
host; this slice owns tab state, visibility rules, tool execution, and the panel UI. On web builds
(`host === null`), the browser is unavailable.

Depth-2 layout: pure `kernel/` (types, URL normalization, state reducer, native IPC sync planner,
tool metadata, messages) ← three isolated cells (`cells/runtime/`, `cells/tools/`, `cells/panel/`) ←
thin `src/index.ts`.

## Public entrypoint

`createBrowserSlice({ log, host, panel, store, openExternal, notify?, newId? })` returns:

| Member                                                                                                 | Meaning                                                                                                                         |
| :----------------------------------------------------------------------------------------------------- | :------------------------------------------------------------------------------------------------------------------------------ |
| `available`                                                                                            | `true` when a desktop `BrowserHost` was injected.                                                                               |
| `capability`                                                                                           | Open `ToolCapability` (`id: 'browser'`, owns `chat-demo:browser` toggle on desktop, `presenter`, `serializeForArchive`).        |
| `declareTools({ enabled })`, `instructions`, `handles(name)`, `toolNames`                              | Tool declaration (invariant 2). `toolNames` are persisted in chat history; never rename.                                        |
| `run(name, input, { signal, sessionId? })`                                                             | Runs one tool call sequentially; always resolves to `{ status, text, images, meta, durationMs }`.                               |
| `setActiveSession(id \| null)`, `start()`                                                              | Active chat (`null` = new-chat screen; also driven by `ActiveSessionChanged`) and host-event binding returning unbind.          |
| `getSession(id)`, `openPanel`, `closePanel`, `togglePanel`, `openUrl`, `takeOver`                      | Per-chat panel & navigation commands (`panelOpen` projected live from `PanelSlot`; `takeOver` emits `BrowserControlTakenOver`). |
| `tabs.{create,close,switch,navigate,setViewport}`, `setStageSize`, `setPanelBounds`, `refreshSnapshot` | Tab, viewport-fit, bounds-sync, and snapshot operations.                                                                        |
| `HeaderToggle`, `BrowserPanel({ topActions? })`, `LocalhostSetting`, `dispose()`                       | Views and full subscription/timer teardown.                                                                                     |

Pure package exports: `isHttpUrl`, `normalizeOmniboxInput`, `computeSomBadgeBoxes`.
Ports: `BrowserHost` (desktop IPC, `null` on web), `PanelSlot` (`spine/ports`), `KeyValueStore`.

## Behavioural invariants

1. **Web build.** Without a host: `available` is false, no tools are declared, every `run` resolves
   to a desktop-only error, and the panel renders nothing.
2. **Declaration.** With a host and `enabled`, all eleven `browser_*` tools are declared; else none.
3. **Per-chat ownership.** Tabs, active tab, and open state never leak across chats. On the new-chat
   screen (`null`), `openPanel` returns `false` and `tabs.create` rejects.
4. **Tabs.** Opening an empty panel creates an `about:blank` tab. Closing the active tab activates
   the neighbor taking its slot (or the previous tab at the end); closing the last tab closes the
   panel.
5. **Native visibility & IPC sync recovery.** The active tab's native webview is shown iff: desktop
   host exists, a chat is active, `PanelSlot` shows the browser for that chat, layout is neither
   animating nor resizing nor overlay-locked, and the tab holds a created `http(s)` webview.
   Otherwise the host hides it. Native sync caches advance only after IPC succeeds; rejected IPC
   calls invalidate the cache so the next sync retries and recovers cleanly. Disposing a tab or
   session while `createTab` is in flight immediately closes the orphaned native webview.
6. **Overlay lock & panel displacement.** Rising `overlayLocked` captures a still snapshot and hides
   the webview until unlocked. Displacing the browser in `PanelSlot` closes the browser panel
   (`panelOpen` is never duplicated outside `PanelSlot`).
7. **Lifecycle facts.** `ActiveSessionChanged` switches active chat; `SessionDeleted` disposes that
   chat and closes its native tabs; `SessionHistoryReplaced` disposes every chat and closes all
   native tabs; `ReplyLifecycleChanged` (`settled`) hides the agent cursor.
8. **URLs (idempotent).** Only `http:`/`https:` are web pages. `normalizeOmniboxInput` keeps
   `http(s)://`, maps `localhost`/`127.0.0.1`/`[::1]` to `http://`, maps `name.tld` to `https://`,
   maps blank or `about:blank` to `'about:blank'`, and turns other text into a Google search. Output
   is always `'about:blank'` or an `isHttpUrl` URL and is idempotent.
9. **Tool runs & action settling.** Calls run serially in call order, politely reveal the panel via
   `panel.reveal`, mark the chat model-controlled while running, and resolve pre-start aborts as
   `aborted` without touching the browser. Navigating actions wait for load + SPA settle;
   `browser_type(submit: true)` yields before `Enter`; only ref-targeted actions scroll into view
   (never coordinate clicks); `browser_press_key` performs default keyboard actions unless prevented;
   detached refs fail loudly with refreshed interactive refs and hints inside the untrusted wrapper.
10. **Untrusted content, iframes, & snapshot framing.** Page text, stale-ref lists, cross-origin
    iframe lists, and `browser_eval` values wrap in `<untrusted_webpage_content …>…</untrusted_webpage_content>`
    with truncation inside the wrapper so the closing tag is never dropped. Interactive elements and
    page text use separate budgets; passwords are redacted; accessible same-origin iframes are
    traversed; visible cross-origin iframes and scrollable containers are listed; screenshot headers
    report CSS viewport pixels plus Retina scale. Layout actions omit page text unless requested;
    same-URL mutations deduplicate unchanged text and emit compact line diffs; `browser_observe` and
    navigations return full text unless `text: false`.
11. **Agent cursor.** One accent-blue kite cursor spans page and toolbar seamlessly across the
    page's top edge, glides on a spring with arc/lean/overshoot and press feedback for page and
    toolbar actions when visible on screen (skipped off-screen; reduced motion jumps with no drift
    or glow), stays hidden during screenshots, ignores pointer events, preserves visual size under
    zoom, and fades out on reply settle, user takeover, or trusted user input.
12. **Viewports, localhost, & new-chat links.** Viewports fit per tab into stage bounds;
    `chat-demo:browser-allow-localhost` (default off) syncs to host on `start()` and change;
    `openUrl` with no active chat opens externally.

## Facts

- **Consumes:** `ActiveSessionChanged`, `SessionDeleted`, `SessionHistoryReplaced`, `ReplyLifecycleChanged`.
- **Publishes:** `BrowserControlTakenOver`.

## Tunable parameters

- **Live native tab LRU cap:** `14` (`MAX_LIVE_NATIVE_TABS`, synced with Rust via `check:ipc`; active and model-controlled sessions are pinned).
- **Navigation delays:** SPA settle `~180 ms`, submit yield `~150 ms`, non-nav settle `~180–250 ms`, nav start window `~2,000 ms`, load timeout `~10–15 s`.
- **Snapshot budgets:** `140` interactive elements, `8` scroll containers, `12` cross-origin iframes, `20` `<select>` options (retaining selected), `12,000` page-text chars, `24,000` total output chars.
- **Agent cursor:** `22 px` kite, `7%` arc (cap `32 px`), `10°` max lean, `2%` overshoot (cap `2.5 px`), stiffness `170 /s²`, max waits `700 ms` (page) / `600 ms` (toolbar) / `450 ms` (typing), press scale `0.84` (`120 ms`), idle drift `1.5 px` / `2.5°`, glow alpha `0.08–0.42` (+`0.4` press, cap `0.6`).
