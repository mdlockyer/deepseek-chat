# SPEC: `slices/conversations` (chats with DeepSeek)

## Purpose

The chat itself: sessions and their message trees (branches from edits and regenerations), sending
a question and streaming the reply, the client-tool loop, attachments and drafts, the composer's
toggles, the local store (IndexedDB) and history import/export as a ZIP. The tools themselves
(web research, Python, the built-in browser, workspace files) belong to other slices and reach the
chat through the tool gateway the app supplies.

## Public entrypoint

`createConversationsSlice(deps)` installs the ports and returns `{ stopReply(sessionId) }`.

**One instance per app.** The chat's state is module-level (one zustand store, one IndexedDB
connection), so the slice may be created once; a second call throws. Tests create it once per test
file (the test runner gives each file its own process).

Until the chat UI moves into the slice (step 6c), the package also exports the functions, hooks
and types that UI uses; they are marked transitional in `src/index.ts`.

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
