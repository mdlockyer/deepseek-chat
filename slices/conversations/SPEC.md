# SPEC: `slices/conversations` (chats with DeepSeek)

## Purpose

The chat itself: sessions and their message trees (branches from edits and regenerations), sending
a question and streaming the reply, the client-tool loop, attachments and drafts, the composer's
toggles, the local store (IndexedDB) and history import/export as a ZIP. The tools themselves
(web research, Python, the built-in browser, workspace files) belong to other slices and reach the
chat through the tool gateway the app supplies.

## Public entrypoint

`createConversationsSlice(deps)` installs the ports and returns the instance:

| Member                                                          | Meaning                                                                               |
| :-------------------------------------------------------------- | :------------------------------------------------------------------------------------ |
| `stopReply(sessionId)`                                          | Stops that chat's reply in progress.                                                  |
| `loadFile(id)`                                                  | Stored file contents (attachments, presented files).                                  |
| `getChatMessages(id)`, `useChatMessages(id)`                    | A loaded chat's visible branch (empty while not loaded).                              |
| `exportHistory()`, `importHistory(file)`, `clearHistory()`      | History as a v3 ZIP; import and clear replace everything.                             |
| `useHistoryState()`, `historyErrorText(error)`                  | Replace in progress / no chats; an import error's reason.                             |
| `useChatLifecycle()`                                            | Starts the chat and follows the chat on screen (call once, outside error boundaries). |
| `useActiveSessionId()`                                          | The chat on screen (`null`: the new-chat screen).                                     |
| `Sider`, `MobileSider`, `CollapsedSider`                        | The session list.                                                                     |
| `ChatMain({ siderCollapsed })`, `ChatSaveBanner`                | Loading state, chat or welcome screen; the save-failure banner.                       |
| `SearchPanel`, `useHasLastSearch()`, `restoreLastSearchPanel()` | Search results in the right-hand panel.                                               |

The package also exports the pure model functions (branches, reply events, the reply view, the API
transport, the archive codec) and the composer toggles; the boundary tests use them.

**One instance per app.** The chat's state is module-level (one zustand store, one IndexedDB
connection), so the slice may be created once; a second call throws. Tests create it once per test
file (the test runner gives each file its own process).

## Ports (`ConversationsDeps`)

| Port                        | Meaning                                                           |
| :-------------------------- | :---------------------------------------------------------------- |
| `log`                       | Event log for the session facts this slice publishes.             |
| `apiOrigin`, `fetch`        | The DeepSeek API and the platform HTTP transport.                 |
| `store`                     | Key-value store for the composer toggles.                         |
| `tools: ToolGateway`        | Declares, describes, classifies and runs client tools (below).    |
| `getApiKey()`               | The DeepSeek API key, or `null`.                                  |
| `getLocationLabel(locale)`  | The user's location as text for the model ('' when unset).        |
| `onActiveSessionChange(id)` | The chat on screen changed (`null`: the new-chat screen).         |
| `browserAvailable`          | Whether the built-in browser exists; its toggle is off otherwise. |
| `onStreamTrace` (optional)  | Diagnostics: each streamed request's timing when it ends.         |

**Tool gateway.** `declare({ search, python, browser, questionText })` returns the client tools for
a turn; `instructions(declaredNames)` the system-prompt sections for them, in order;
`kindOf(name)` one of `web_search`, `web_scrape`, `browser`, `present_file`, `edit_file`,
`read_file`, `python`, or `null`; `fenceLanguage(path)` the Markdown fence language for a presented
file; `run(call, context)` runs one call and always resolves to the result written into the call's
`tool_result` block. The context gives the session, abort signal, the reply's blocks so far, the
visible branch with the reply last, whether the chat is on screen, a phase callback, and the file
store (save/load).

**View ports (`ui`).** `voice`: the voice input hook, voice button, spectrum, read-aloud button
and stop. `panels.files`: whether the file panel shows a given file (`presented` or `upload`), open
it, and the header toggle (`visible`, `open`, `toggle`). `panels.browser`: the header toggle, or
`null` without a browser. `panels.search`: this slice's `PanelSlot`. `openSettings(section)`,
`openInApp(url)` (or `null`: ordinary links), `saveFile(name, blob)`, `setSiderCollapsed`.

## Behavioural invariants

1. **Facts.** After a session is deleted from storage the slice publishes `SessionDeleted` for it,
   once, and removes it from the list; other chats are untouched. After the whole history is
   replaced (import, clear) it publishes `SessionHistoryReplaced`, once. Neither is published when
   the change fails, and a failed import leaves every chat as it was.
2. **Tool calls.** Every call the model makes runs through the gateway exactly once, in the order
   the model made it. While it runs, its result shows as running (phase `starting` exactly when its
   kind is `python`); afterwards its `tool_result` holds the gateway's result. The next request
   sends every result back to the model, in call order. When the turn is aborted during a call, no
   later call runs and no further request is made; the reply ends stopped. A turn whose model keeps
   calling tools still ends (after a bounded number of rounds, see Parameters).
3. **Prompt.** A turn's system prompt is the assistant identity followed by the gateway's
   instructions for exactly the tools declared that turn, in the gateway's order.
   3a. **Tool context.** A run sees the chat's visible branch with the reply in progress last, knows
   whether that chat is on screen, and files it saves can be read back through `loadFile`.
4. **Tool steps by kind.** How a call is shown (search, opened page, browser actions, file actions,
   code) and archived depends only on `kindOf(name)`; anything unclassified is shown as code.
5. **Composer toggles** (DeepThink, Search, Run code, Browser) load from and save to the store under
   `chat-demo:thinking`, `chat-demo:search`, `chat-demo:python`, `chat-demo:browser` as `'true'` /
   `'false'`.
6. **Branches.** A chat is a tree. Sending adds a question and its reply below the visible leaf.
   Editing a question adds a sibling question (and its reply) and selects it; regenerating adds a
   sibling reply and selects it; selecting a version selects that sibling. Each message remembers
   which child was selected below it, so the visible branch is the path of selected children from
   the root. Questions and replies alternate along it, starting with a question.
7. **History archive** rules (format, validation, replacement, what is kept) are in
   [`src/history/README.md`](src/history/README.md).
8. **Requests.** REST requests time out after 15 s, uploads after 60 s; a timeout is reported as a
   network error saying the request timed out, and a caller's abort is passed through as an abort.
   The reply stream itself has no overall timeout.
9. **Session list groups:** Today, Yesterday, Previous 7 days, Previous 30 days, then by month.
10. **Missing API key.** Sending, attaching, editing a question or starting voice input without a
    key opens Settings on the key section instead.
11. **Search results panel.** Clicking a reply's sources shows them in the search slot; clicking the
    same sources again closes it. When the slot shows something else, the last results are kept and
    `restoreLastSearchPanel` shows them again. Switching chats closes them.
12. **Links.** Citation marks and browser-step links open with `openInApp` when given (desktop:
    the built-in browser); otherwise citations open a new tab and other links behave normally.
13. **Following the chat on screen** (`useChatLifecycle`): the right-hand panels follow it
    (`onActiveSessionChange`), read-aloud stops, search results close, and the mobile drawer
    closes.
14. **History round trip.** Exporting the history and importing that file restores the same chats
    with the same titles and, for each, the same visible branch (roles and text). Choices on
    branches that were not visible are not kept (see the history README).
15. **Stream traces.** When `onStreamTrace` is given, every streamed request reports one trace when
    it ends (completed, failed or aborted): its tool round, the stop reason, and per content block
    its type (with the tool name), delta count, characters received and timings, ordered in time.
    A trace never contains message, tool-input or reply content.
16. **Still working.** While a reply streams and nothing new has arrived for the stall delay (see
    Parameters), a "Working…" line shows at the end of the reply, until the next content arrives.
    It does not show while the reply has nothing yet (the waiting dots or the thinking title show
    instead), or while its last step already shows it is running (a tool without its result, a
    running Python call, thinking in progress). The server may hold a whole tool call back until
    its input (e.g. a file) is written, so this gap can last tens of seconds.
17. **Files with the answer.** The files a reply produced (from any tool result: presented or
    edited files, files from Python) show as cards with the answer, not inside the thinking and
    tools timeline, so they stay visible when the timeline is collapsed. There is one card per file
    (by path, or by name when there is no path), in the order the files first appeared, showing
    the latest version. The timeline keeps each file step's line and errors. The cards appear once
    the reply has finished (done, stopped or failed); while it streams there are none, since the
    file panel opens by itself and follows each new version.

## Parameters

| Name                                     | Value                                       |
| :--------------------------------------- | :------------------------------------------ |
| Loaded chat details kept in memory       | 5 (plus active, streaming and unsaved ones) |
| Tool rounds per turn                     | 50                                          |
| Network retries per turn                 | 2                                           |
| Re-uploads after the server drops a file | 2 (backoff 1 s × 2ⁿ)                        |
| Attachments per message                  | 50                                          |
| Attachment size                          | 64 MB                                       |
| Concurrent uploads                       | 3                                           |
| Request body limit                       | 3,000,000 bytes                             |
| Stall delay before "Working…"            | 1.5 s                                       |
