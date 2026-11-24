# SPEC: `slices/conversations` (chats with DeepSeek)

## Purpose

The chat itself: sessions and their message trees (branches from edits and regenerations), sending
a question and streaming the reply, the client-tool loop, attachments and drafts, the composer's
toggles, the local store (IndexedDB) and history import/export as a ZIP. The tools themselves
(web research, Python, the built-in browser, workspace files) belong to other slices and reach the
chat through the tool gateway the app supplies.

## Public entrypoint

`createConversationsSlice(deps)` installs the ports and returns the instance:

| Member                                                                | Meaning                                                                               |
| :-------------------------------------------------------------------- | :------------------------------------------------------------------------------------ |
| `stopReply(sessionId)`                                                | Stops that chat's reply in progress.                                                  |
| `loadFile(id)`                                                        | Stored file contents (attachments, presented files).                                  |
| `getChatMessages(id)`, `useChatMessages(id)`                          | A loaded chat's visible branch (empty while not loaded).                              |
| `exportHistory()`, `importHistory(file)`, `clearHistory()`            | History as a v3 ZIP; import and clear replace everything.                             |
| `useHistoryState()`, `historyErrorText(error)`                        | Replace in progress / no chats; an import error's reason.                             |
| `useChatLifecycle()`                                                  | Starts the chat and follows the chat on screen (call once, outside error boundaries). |
| `useActiveSessionId()`                                                | The chat on screen (`null`: the new-chat screen).                                     |
| `Sider`, `MobileSider`, `CollapsedSider`                              | The session list.                                                                     |
| `ChatMain({ siderCollapsed })`, `ChatSaveBanner`                      | Loading state, chat or welcome screen; the save-failure banner.                       |
| `ActivityPanel`, `useHasLastActivity()`, `restoreLastActivityPanel()` | Unified turn activity & sources inspector in the right-hand panel.                    |
| `commands`                                                            | Headless versions of what the views do (send, attach, edit, regenerate, continue…).   |

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
a turn; `instructions(declaredNames, audience)` the system-prompt sections for them, worded for
`reply` or `agent`, in order; `describe(name, audience)` one tool's schema with `summary` injected
and worded for the audience; `kindOf(name)` one of `web_search`, `web_scrape`, `browser`,
`present_file`, `edit_file`, `read_file`, `python`, `ask_user`, `subagent`, or `null`;
`effectOf(name)` one of `read`, `spawn`, `session`, `artifact`, or `interactive`;
`agentProfile(name)` returns the profile when `kindOf(name) === 'subagent'` (and `null` otherwise);
`fenceLanguage(path)` the Markdown fence language for a presented file; `run(call, context)` runs
one call and always resolves to the result written into the call's `tool_result` block. The context
gives the session, abort signal, `caller` (`reply` or `{ kind: 'agent', profile, runId }`),
`citedUrls`, the reply's blocks so far, the visible branch with the reply last, whether the chat is
on screen, a phase callback, and the file store (save/load).

**View ports (`ui`).** `voice`: the voice input hook, voice button, spectrum, read-aloud button
and stop. `panels.files`: whether the file panel shows a given file (`presented` or `upload`), open
it, and the header toggle (`visible`, `open`, `toggle`). `panels.browser`: the header toggle, or
`null` without a browser. `panels.activity`: this slice's `PanelSlot`. `openSettings(section)`,
`openInApp(url)` (or `null`: ordinary links), `saveFile(name, blob)`, `setSiderCollapsed`.

## Behavioural invariants

1. **Facts.** After a session is deleted from storage the slice publishes `SessionDeleted` for it,
   once, and removes it from the list; other chats are untouched. After the whole history is
   replaced (import, clear) it publishes `SessionHistoryReplaced`, once. Neither is published when
   the change fails, and a failed import leaves every chat as it was.
2. **Tool calls.** Every call the model makes runs through the gateway (or conversations' own
   subagent runtime for `subagent`, `post`, and `wait`) exactly once, starting in the order the
   model made it, and each call's effect (`effectOf(name)`) decides how it runs:
   - `read` calls in a consecutive run go concurrently, up to the parallel-call parameter.
   - A `spawn` call (starting a child) returns as soon as the child has started, with its `runId`,
     and never waits.
   - Any other call, `wait` included, runs alone after the calls before it have finished.
     While a call runs, its result shows as running (phase `starting` exactly when its kind is
     `python`); afterwards its `tool_result` holds the result. Results are written in call order,
     each result is saved as soon as its call ends, concurrent `read` batches reconcile search
     citation numbers in call order so they match `buildReplyView`'s source numbering without
     collisions, and the next request sends every result back to the model in call order. When the
     turn is aborted during a call or concurrent run, no queued call starts and no further request
     is made; the reply ends stopped. A turn whose model keeps calling tools still ends (after a
     bounded number of rounds, see Parameters).
3. **Prompt.** A turn's system prompt is the assistant identity followed by the gateway's
   instructions for exactly the tools declared that turn, in the gateway's order.
   3a. **Tool context.** A run sees the chat's visible branch with the reply in progress last, knows
   whether that chat is on screen, and files it saves can be read back through `loadFile`.
4. **Tool steps by kind.** How a call is shown (search, opened page, browser actions, file actions,
   clarifying questions, subagents, wait/board, code) and archived depends only on `kindOf(name)`
   (plus conversations' own `post` and `wait` tools); anything unclassified is shown as code.
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
   8a. **Reply requests.** A reply sends one request to the model at the start and one after each
   tool round. For each of them:
   - If it fails with a network error before any content block arrived, it is sent again after a
     backoff, up to the network-retry parameter (counted for the whole turn). Past that, the reply
     ends failed with the network error.
   - If it fails after content arrived, it is not sent again: the reply ends failed and keeps what
     arrived.
   - A stream that ends after its stop reason but before `message_stop` counts as complete: its
     tool calls run and the turn goes on as after any other complete response.
   - If the server answers that an attached file no longer exists, the reply uploads those files
     again from their local copies and sends the request again, up to the re-upload parameter
     (counted per request). Past that, the reply ends failed with the server's error.
   - If the attachments can't be made ready (a re-upload fails), the reply ends as an upload error
     and the request is not sent.
9. **Session list groups:** Today, Yesterday, Previous 7 days, Previous 30 days, then by month.
10. **Missing API key.** Sending, attaching, editing a question or starting voice input without a
    key opens Settings on the key section instead.
11. **Activity & sources panel.** Clicking a reply's work strip or sources button opens that turn
    in the right-hand activity slot (on the `Activity` or `Sources` tab respectively) and updates
    live while the reply streams; clicking the same trigger again closes it. When the slot switches
    to another right-hand panel on the same chat, the last inspected target is kept and
    `restoreLastActivityPanel` restores it. Switching chats or branches closes it. Inside
    `Activity`, consecutive web research calls merge across intervening thinking blocks, raw
    `wait` plumbing is folded out, board posts attach to subagents as shared notes, and `Sources`
    lists cited sources first followed by all other deduplicated sources.
12. **Links.** Citation marks, source cards, and activity-panel page/browser links open with
    `openInApp` when given (desktop: the built-in browser); otherwise citations open a new tab and
    other links behave normally.
13. **Following the chat on screen** (`useChatLifecycle`): the right-hand panels follow it
    (`onActiveSessionChange`), read-aloud stops, the activity panel closes, and the mobile drawer
    closes.
14. **History round trip.** Exporting the history and importing that file restores the same chats
    with the same titles and, for each, the same visible branch (roles and text). Choices on
    branches that were not visible are not kept (see the history README).
15. **Stream traces.** When `onStreamTrace` is given, every streamed request reports one trace when
    it ends (completed, failed or aborted): its tool round, the stop reason, and per content block
    its type (with the tool name), delta count, characters received and timings, ordered in time.
    A trace never contains message, tool-input or reply content.
16. **Still working.** While a reply streams and nothing new has arrived for the stall delay (see
    Parameters), a "Working…" status shows until the next content arrives — in-place inside the
    bounded live work strip before answer prose begins, and below the answer if a stall occurs
    mid-answer. It does not show while the reply has nothing yet (the waiting state shows instead),
    or while its last step is a tool that already shows it is running (a tool without its result, a
    running Python call, a running `wait` call, or a running child row). An open thinking block
    does not count: during a stall it receives nothing, and it may stay open until the held-back
    tool call arrives. The server may hold a whole tool call back until its input (e.g. a file) is
    written, so this gap can last tens of seconds.
17. **Deliverables with the answer.** Files a reply produced (from any tool result: presented or
    edited files, files from Python) and generated visual outputs from Python (`images`) show Front
    Stage with the answer, not buried inside the backstage activity panel. File cards show one card
    per file (by path, or by name when there is no path), in first-seen order at the latest
    version, once the reply finishes (done, stopped or failed); while streaming there are no file
    cards, since the file panel opens by itself and follows each new version. Generated Python
    images show with the answer as soon as they arrive.
18. **Living session titles (turn-end hook).** After a reply finishes normally (not stopped, failed
    or refused), if the user has not locked the title by manually renaming the chat, a detached
    background fork request rides the turn's exact prompt prefix (`model`, `system`, `tools`,
    `safety_check`, and `messages` up through the finished reply) with one ephemeral final user
    prompt asking for an updated title or `KEEP`. On turn 1 it is skipped when the inline
    `delta.title` already named the chat. The fork is never persisted to `session.messages`, never
    executes tools, never blocks the next turn, and never bumps `updatedAt`. Any new send, edit,
    regenerate, branch switch, manual rename, delete or history replacement cancels an in-flight
    title refresh. Clearing a title manually unlocks auto-titling again.
19. **One activity whale & bounded work strip.** While a reply streams, at most one animated whale
    shows per reply on the turn's single Work Strip (or on the mid-answer stall line if the answer
    is already streaming and stalled). While working before the answer arrives, the Work Strip
    stays bounded to at most 2 lines for single-threaded tools (active verb + tally on line 1,
    latest plain-prose `summary` on line 2) and at most 3 compact active tracks (plus overflow
    count) when parallel subagents run. A clarifying question waiting for the user keeps its
    pulsing dot, because the user, not the model, has the next move; answered clarifying questions
    remain visible Front Stage as a compact decision line. Once the answer arrives or the reply
    ends, the Work Strip collapses to a single summary button carrying the still whale (muted grey
    if stopped, or a warning icon if any tool step failed).
20. **Subagents (runtime rules 2–16).**
    - **Read-only and depth 1:** a child receives only `read` tools from its profile (never another
      subagent), `post`, and its profile's `finish` tool. Any call to another tool gets an error
      result without invoking the gateway.
    - **Concurrency:** a child's calls follow the effect rules of invariant 2: consecutive allowed
      `read` calls run concurrently up to the parallel-call parameter (counted per child), `post`
      and refused calls run alone, and results return to the child in call order.
    - **Caps:** at most `maxRunningChildren` run concurrently and at most `maxChildrenPerReply` start
      in one reply; a `spawn` beyond either cap gets an error naming the cap and starts no child.
    - **Context:** `'clean'` isolates the child to its profile prompt, task, `latest_reminder`, own
      transcript, and board posts; `'fork'` prepends the lead's messages up to the spawn call.
    - **Outcomes:** every child ends `finished`, `exhausted` (after one forced-finish request when
      hitting round or tool-call limits, or when ending without calling finish), `failed`, or
      `stopped`. Results arrive on the lead's next `wait`. The forced-finish request names the
      finish tool in `tool_choice` only when the profile's thinking is off, because DeepSeek
      answers a named `tool_choice` with HTTP 400 in thinking mode; a thinking child gets the
      nudge alone. If that request fails, or the child still doesn't call finish, it ends
      `exhausted` and delivers its last text with no sources, plus the request's error when it
      failed. `exhausted.limit` says why: `rounds`, `toolCalls`, or `noFinishCall` (the child
      ended its turn without calling finish and ignored the nudge).
    - **Network retries:** a child's request that fails with a network error before any content
      block arrived is sent again, with the lead's retry count and backoff, counted per child run.
      A stream that ends after its stop reason but before `message_stop` counts as complete.
    - **Citation numbering:** conversations assigns reply-wide citation numbers across direct web
      tools and child sources delivered via `wait`, continuing without gaps and rewriting `[n]` to
      `[citation:M]`. `buildReplyView` registers sources from any `tool_result` that carries them.
    - **No orphans & round limit:** if the lead ends its turn while children are running, the
      runtime adds a `wait` with `until: 'all'` (timeout `autoWaitTimeoutS`) and continues — unless
      `toolRoundLimit` is reached, which wins and stops running children with reason `roundLimit`.
    - **Stopping & recovery:** stopping the reply aborts every running child (`reason: 'user'`);
      a reply that ends with an API error stops them with `reason: 'interrupted'`. Finished and
      exhausted children keep their results, saved in their `finished` / `exhausted` state. Loading a chat settles any
      `running` child to `stopped` (`reason: 'interrupted'`). Continuing a reply delivers, on the
      lead's first `wait` and without hanging, every ended child whose result no earlier `ok` `wait`
      result carries under its `### Subagent <runId> (` heading.
    - **Storage, timeline, and archives:** runs (`AssistantMessage.agents`) and board posts
      (`AssistantMessage.board`) persist on the reply at step boundaries; finished child tool
      results are trimmed to `childToolResultDisplayChars` for display. Conversations declares
      `post` and `wait` (with their prompt section) whenever any declared tool has kind `subagent`.
      Archives keep tool result text (including `wait` results and board posts) and omit child
      transcripts.
21. **Shared board and `wait`.** Children post `finding` (`text`, `url`) or `question` (`question`,
    `assumption`) up to `maxPostsPerChild` and `maxPostChars` each; the lead posts `direction` to
    `all` or one running `runId` (a direction to an ended child gets an error result). Unseen posts
    are appended under `"On the board since your last step"` before each agent's next request, in
    posting order, never to their author. Nothing blocks on a question. `wait` wakes on a finished
    child, a child `question`, or timeout (never on a `finding` alone); `until: 'all'` returns only
    once no child is running.

## Parameters

| Name                                        | Value                                       |
| :------------------------------------------ | :------------------------------------------ |
| Loaded chat details kept in memory          | 5 (plus active, streaming and unsaved ones) |
| Tool rounds per turn                        | 50 (`toolRoundLimit`)                       |
| Concurrent `read` calls per batch           | 6 (`maxParallelReadCalls`)                  |
| Running subagents per reply                 | 5 (`maxRunningChildren`)                    |
| Subagents started per reply                 | 12 (`maxChildrenPerReply`)                  |
| Default `wait` timeout                      | 60 s (`waitDefaultTimeoutS`)                |
| Automatic `wait` timeout                    | 600 s (`autoWaitTimeoutS`)                  |
| Board posts per child                       | 6 (`maxPostsPerChild`)                      |
| Board post length                           | 400 chars (`maxPostChars`)                  |
| Stored child tool-result display length     | 2,000 chars (`childToolResultDisplayChars`) |
| Network retries per turn and per child      | 2 (`networkRetryLimit`)                     |
| Re-uploads per request after a dropped file | 2 (`fileReuploadLimit`)                     |
| Backoff before retry n (from 0)             | 1 s × 2ⁿ (`retryBaseDelayMs`)               |
| Attachments per message                     | 50                                          |
| Attachment size                             | 64 MB                                       |
| Concurrent uploads                          | 3                                           |
| Request body limit                          | 3,000,000 bytes                             |
| Stall delay before "Working…"               | 1.5 s                                       |
