# SPEC: `slices/conversations` (chats with DeepSeek)

## Purpose

Core chat domain: sessions and their message trees (branches from edits and regenerations), sending
a question and streaming the reply, the domain-blind client-tool loop, attachments and drafts, the
DeepThink composer toggle, factory-scoped local session persistence, and the chat views.

Sibling capabilities (web research, Python, built-in browser, workspace files, clarifying questions,
subagents, activity inspection, history backup, voice) are sealed slices outside `conversations`.
They plug in through the open `ToolRegistry` contract (`@deepseek-chat/lib-tools`), Spine facts on
the `EventLog`, and optional view ports.

## Public entrypoint

`createConversationsSlice(deps)` creates an isolated slice instance (multiple independent instances
may coexist in the same process) and returns:

| Member                                           | Meaning                                                                                                                                                                                      |
| :----------------------------------------------- | :------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `stopReply(sessionId)`                           | Stops that chat's reply in progress.                                                                                                                                                         |
| `commands`                                       | Headless operations: `init`, `newChat`, `selectSession`, `renameSession`, `removeSession`, `setDraft`, `attach`, `send`, `regenerate`, `continueReply`, `edit`, `selectVersion`, `whenIdle`. |
| `getState()`                                     | Session summaries (newest first), `activeId`, `ready`, and `replying` session IDs.                                                                                                           |
| `getThinking()`, `setThinking(enabled)`          | Instance-scoped DeepThink toggle (`chat-demo:thinking`).                                                                                                                                     |
| `getChatMessages(id)`, `useChatMessages(id)`     | A loaded chat's visible branch (empty while not loaded).                                                                                                                                     |
| `getTurnSnapshot(sid, mid)`, `subscribeToTurns`  | Read-only live turn snapshot source consumed by `slices/activity-inspector`.                                                                                                                 |
| `snapshotForExport()`, `replaceSessions(fn)`     | Atomic storage ports consumed by `slices/history-backup`.                                                                                                                                    |
| `useHistoryState()`, `describeReplyNotice(msg)`  | History replacement/empty state and plain reply error/template text.                                                                                                                         |
| `request`                                        | Instance-scoped DeepSeek HTTP helper bound to `deps.fetch`.                                                                                                                                  |
| `useChatLifecycle()`, `useActiveSessionId()`     | Lifecycle hooks for upload notices, persistence flush, mobile drawer, and init.                                                                                                              |
| `Sider`, `MobileSider`, `CollapsedSider`         | Bound session-list views.                                                                                                                                                                    |
| `ChatMain({ siderCollapsed })`, `ChatSaveBanner` | Bound chat/welcome main area and save-failure banner.                                                                                                                                        |
| `dispose()`                                      | Aborts active streams, cancels timers, unsubscribes from `EventLog`, closes DB.                                                                                                              |

The package also exports pure model functions (`branches`, `reply`, `view`, `workStrip`, `citations`,
`autoTitle`, `requestWith`, `ServerSentEventDecoder`) and session store factories
(`createIndexedDbSessionStore`, `memorySessionStore`).

## Ports (`ConversationsDeps`)

| Port                      | Meaning                                                                                                                                                                |
| :------------------------ | :--------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------- |
| `log`                     | Spine `EventLog` for session facts published and browser facts consumed.                                                                                               |
| `apiOrigin`, `fetch`      | DeepSeek API origin and platform HTTP transport.                                                                                                                       |
| `store`                   | Key-value store for `chat-demo:thinking`.                                                                                                                              |
| `blobs: BlobStore`        | Domain-blind blob store for user uploads and delivered files.                                                                                                          |
| `sessions?: SessionStore` | Optional session store (defaults to IndexedDB `deepseek-sessions`).                                                                                                    |
| `tools?: ToolRegistry`    | Aggregated `ToolCapability` registry (defaults to empty for bare chat).                                                                                                |
| `platform`                | `'desktop'                                                                                                                                                             | 'web'`for`latest_reminder`. |
| `getApiKey()`             | DeepSeek API key, or `null`.                                                                                                                                           |
| `getLocationLabel(loc)`   | User location label for `latest_reminder` (`''` when unset).                                                                                                           |
| `onStreamTrace`           | Optional diagnostics hook reporting request timings without content.                                                                                                   |
| `autoTitle`               | Enables detached cache-riding auto-title refresh (default `true`).                                                                                                     |
| `notify`                  | Optional `NoticePort` for upload/copy/delete toasts.                                                                                                                   |
| `ui`                      | Optional view slots (`voice`, `headerActions`, `composerDock`, `openFile`, `useActiveInspectionTarget`, `openInApp`, `saveFile`, `openSettings`, `setSiderCollapsed`). |

## Spine facts

- **Publishes (sticky):** `ActiveSessionChanged` (key `'unit'`), `SessionFilesChanged` (key `sessionId`, tombstoned on delete/history replace).
- **Publishes (discrete):** `ReplyLifecycleChanged`, `ToolFileDelivered`, `TurnInspectionRequested`, `SessionDeleted`, `SessionHistoryReplaced`.
- **Subscribes:** `BrowserControlTakenOver` (aborts the active reply for that session).

## Behavioural invariants

1. **Multi-instance isolation.** Every store, draft map, upload queue, auto-title controller, and
   session store handle is scoped to the `createConversationsSlice` instance. Actions in instance A
   never mutate state or receive facts from instance B. Calling `dispose()` stops all streams and
   releases all `EventLog` listeners.
2. **Facts.** After deleting a session from storage, the slice tombstones its `SessionFilesChanged`
   entry, publishes `SessionDeleted` once, and removes it without affecting other chats. After
   replacing all history, it tombstones all `SessionFilesChanged` entries and publishes
   `SessionHistoryReplaced` once. Failed deletes or replacements publish nothing and leave state
   intact.
3. **Domain-blind tool loop.** Every tool call executes through `tools.run` exactly once, starting
   in call order, scheduled strictly by `tools.effectOf(name)`:
   - Consecutive `read` calls execute concurrently up to `maxParallelReadCalls`.
   - `spawn` calls return immediately without waiting.
   - All other effects (`session`, `artifact`, `interactive`) execute serially after prior calls finish.
     While running, a `tool_result` block holds `status: 'running'` and optional `progress` seeded by
     `tools.initialProgressOf(name)` and updated via `ctx.onProgress`. Results are written in call
     order; concurrent `read` batches reconcile citations in call order via
     `result.formatContentWithCitations`. Abort stops queued calls and makes no further requests.
4. **Turn lifecycle hooks.** When a model round finishes with zero tool calls, registered
   `turnHooks.onTurnEndWithoutToolCalls` may inject a synthetic tool call to continue the loop
   (bounded by `toolRoundLimit`). When the turn settles (`done`, `user`, `interrupted`,
   `roundLimit`), `turnHooks.onTurnSettled` runs for every registered capability. When hydrating
   persisted replies from storage, `turnHooks.onReplyHydrated` normalizes persisted
   `capabilityState[id]`.
5. **Prompt.** Each turn's static `system` prompt is the core assistant identity followed by
   `tools.instructions(declaredNames, 'reply')`. It contains no em dashes and stays identical across
   turns with the same declared tools for KV-cache reuse.
6. **DeepThink toggle.** Persisted under `chat-demo:thinking` as `'true'` / `'false'` via `deps.store`.
   All other composer toggles come dynamically from `tools.toggles`.
7. **Branches.** A chat is a tree. Sending appends below the visible leaf; editing adds a sibling
   user node and reply; regenerating adds a sibling assistant node; switching versions updates
   `selectedChildId` and re-publishes `SessionFilesChanged`.
8. **Requests & retries.** REST requests time out after 15 s, uploads after 60 s. Pre-content
   network failures retry up to `networkRetryLimit` per turn with exponential backoff. Post-content
   failures do not retry and keep partial text. Streams ending after `message_delta` stop reason
   without `message_stop` count as complete. Missing server file errors re-upload from `blobs` up
   to `fileReuploadLimit` per request.
9. **Deliverables & Front Stage.** Delivered files (`result.files`) deduplicate by `path ?? name`
   at latest version in first-seen order and appear once streaming ends. Tool `images` without
   `previewImages` promote to Front Stage (`view.images`); tools that supply clean `previewImages`
   keep their screenshots backstage in the Activity Inspector. `buildTurnWorkStrip` is driven solely
   by `ToolStepPresenter.summarize` and `result.frontStageNote`.
10. **Living session titles.** After a reply finishes normally, if the title is unlocked and inline
    `delta.title` did not already name turn 1, a detached cache-riding fork updates the title
    without altering `session.messages` or `updatedAt`. Any user mutation cancels an in-flight fork.
11. **Stream traces.** When `onStreamTrace` is provided, every request reports sizes and timings
    without message, tool input, or reply text.

## Parameters

| Name                                        | Value                                       |
| :------------------------------------------ | :------------------------------------------ |
| Loaded chat details kept in memory          | 5 (plus active, streaming and unsaved ones) |
| Tool rounds per turn                        | 50 (`toolRoundLimit`)                       |
| Concurrent `read` calls per batch           | 6 (`maxParallelReadCalls`)                  |
| Network retries per turn                    | 2 (`networkRetryLimit`)                     |
| Re-uploads per request after a dropped file | 2 (`fileReuploadLimit`)                     |
| Backoff before retry n (from 0)             | 1 s × 2ⁿ (`retryBaseDelayMs`)               |
| Attachments per message                     | 50                                          |
| Attachment size                             | 64 MB                                       |
| Concurrent uploads                          | 3                                           |
| Request body limit                          | 3,000,000 bytes                             |
| Stall delay before "Working…"               | 1.5 s                                       |
