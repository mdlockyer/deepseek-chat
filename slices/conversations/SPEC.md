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

1. **Facts.** After a session is deleted from storage the slice publishes `SessionDeleted`; after
   the whole history is replaced (import, clear) it publishes `SessionHistoryReplaced`. Neither is
   published when the change fails.
2. **Tool calls run in order.** Each call first appears as a running result (with phase
   `starting` when its kind is `python`), then takes the gateway's result. When the turn is aborted
   the loop stops after the current call. At most 50 tool rounds per turn.
3. **Prompt.** A turn's system prompt is the assistant identity followed by the gateway's
   instructions for the tools declared that turn.
4. **Tool steps by kind.** How a call is shown (search, opened page, browser actions, file actions,
   code) and archived depends only on `kindOf(name)`; anything unclassified is shown as code.
5. **Composer toggles** (DeepThink, Search, Run code, Browser) load from and save to the store under
   `chat-demo:thinking`, `chat-demo:search`, `chat-demo:python`, `chat-demo:browser` as `'true'` /
   `'false'`.
6. **Branches.** Editing a question or regenerating a reply adds a sibling version; the visible
   branch follows the selected version at each level.
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
