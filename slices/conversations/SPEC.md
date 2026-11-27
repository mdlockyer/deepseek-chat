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

| Member                                                                                       | Meaning                                                                                                                                                                                                                                                                                                                                                                                                                                              |
| :------------------------------------------------------------------------------------------- | :--------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `stopReply(sessionId)`                                                                       | Stops that chat's reply or manual compaction in progress.                                                                                                                                                                                                                                                                                                                                                                                            |
| `commands`                                                                                   | Headless operations: `init`, `newChat`, `selectSession`, `renameSession`, `removeSession`, `setDraft`, `attach`, `send`, `regenerate`, `continueReply`, `edit`, `selectVersion`, `compact`, `whenIdle`.                                                                                                                                                                                                                                              |
| `getState()`, `subscribe(listener)`                                                          | Session summaries (newest first), `activeId`, `ready`, `replying` session IDs, and change subscription.                                                                                                                                                                                                                                                                                                                                              |
| `getThinking()`, `setThinking(enabled)`                                                      | Instance-scoped DeepThink toggle (`chat-demo:thinking`).                                                                                                                                                                                                                                                                                                                                                                                             |
| `getChatMessages(id)`, `getChatCheckpoints(id)`, `useChatMessages(id)`                       | A loaded chat's visible branch and stored compaction checkpoints (empty while not loaded).                                                                                                                                                                                                                                                                                                                                                           |
| `getTurnSnapshot(sid, mid)`, `listSessionTurns(sid)`, `subscribeToTurns`                     | Referentially stable read-only live turn snapshot & session turn-list source consumed by `slices/activity-inspector` (safe for `useSyncExternalStore`).                                                                                                                                                                                                                                                                                              |
| `getReadingPosition(sid)`, `subscribeToReading`, `revealTurn(sid, mid)`, `revealLatest(sid)` | The turn each chat's transcript is on (`{ messageId, cause: 'reader' \| 'reveal' }`, changing once per turn crossed) and requests to bring a turn, or the latest output, into view. Consumed by `slices/activity-inspector`.                                                                                                                                                                                                                         |
| `snapshotForExport()`, `replaceSessions(fn)`                                                 | Atomic storage ports consumed by `slices/history-backup`.                                                                                                                                                                                                                                                                                                                                                                                            |
| `useHistoryState()`, `describeReplyNotice(msg)`                                              | History replacement/empty state and plain reply error/template text.                                                                                                                                                                                                                                                                                                                                                                                 |
| `useChatLifecycle()`, `useActiveSessionId()`                                                 | Lifecycle hooks for upload notices, persistence flush, mobile drawer, and init.                                                                                                                                                                                                                                                                                                                                                                      |
| `Sider`, `MobileSider`, `SiderToolbar`                                                       | Bound session-list views. `SiderToolbar({ siderMode: 'collapsed' \| 'expanded', exiting? })` is the desktop sidebar toggle: one open/close button (label and `aria-expanded` follow the mode) plus a "+" that is shown only while collapsed. It is one element that travels with the sidebar: at the sidebar's right edge while expanded, beside the traffic lights in a pill while collapsed. The in-panel toggle exists only in the mobile drawer. |
| `ChatMain({ siderMode })`, `ChatSaveBanner`                                                  | Bound chat/welcome main area (`siderMode`: `'absent' \| 'collapsed' \| 'expanded'`), top-right Settings trigger, and save-failure banner.                                                                                                                                                                                                                                                                                                            |
| `dispose()`                                                                                  | Aborts active streams, cancels timers, unsubscribes from `EventLog`, closes DB.                                                                                                                                                                                                                                                                                                                                                                      |

The package also exports pure model functions (`branches`, `reply`, `environmentContext`, `view`,
`workStrip`, `citations`, `autoTitle`, `requestWith`, `ServerSentEventDecoder`) and session store
factories (`createIndexedDbSessionStore`, `memorySessionStore`).

## Ports (`ConversationsDeps`)

| Port                      | Meaning                                                                                                                                                                                  |
| :------------------------ | :--------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `log`                     | Spine `EventLog` for session facts published and browser facts consumed.                                                                                                                 |
| `provider: ModelProvider` | Provider-neutral streaming Messages transport + model metadata + optional remote attachment upload port (`attachments`).                                                                 |
| `store`                   | Key-value store for `chat-demo:thinking`.                                                                                                                                                |
| `blobs: BlobStore`        | Domain-blind blob store for user uploads and delivered files.                                                                                                                            |
| `sessions?: SessionStore` | Optional session store (defaults to IndexedDB `deepseek-sessions`).                                                                                                                      |
| `tools?: ToolRegistry`    | Aggregated `ToolCapability` registry (defaults to empty for bare chat).                                                                                                                  |
| `platform`                | `'desktop' \| 'web'` for `<environment_context>`.                                                                                                                                        |
| `getLocationLabel(loc)`   | User location label for `<environment_context>` (`''` when unset).                                                                                                                       |
| `onStreamTrace`           | Optional diagnostics hook reporting request timings without content.                                                                                                                     |
| `autoTitle`               | Enables detached cache-riding auto-title refresh on every completed turn (default `true`).                                                                                               |
| `notify`                  | Optional `NoticePort` for upload/copy/delete toasts.                                                                                                                                     |
| `ui`                      | Optional view slots (`voice`, `headerActions`, `composerDock`, `openFile`, `useActiveInspectionTarget`, `useNeedsApiKey`, `openInApp`, `saveFile`, `openSettings`, `setSiderCollapsed`). |

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
   The composer box holds only the draft (attachments, text, send / stop). Under it, `+` offers
   file upload and conversation compaction, and the tools pill shows one icon per toggle that is
   on (a neutral sliders icon when none is), with no model name and no chevron; it opens the menu
   with DeepThink and every tool toggle. Both open as `MorphMenu`s that grow out of their button:
   the `+` menu shares its bottom-left corner with `+`, the tools menu its bottom-right corner with
   the pill. The
   composer shows no context meter; compaction stays automatic and reachable from `+`.
7. **Branches.** A chat is a tree. Sending appends below the visible leaf; editing adds a sibling
   user node and reply; regenerating adds a sibling assistant node; switching versions updates
   `selectedChildId` and re-publishes `SessionFilesChanged`.
8. **Requests, attachments, & retries.** REST requests time out after 15 s, uploads after 60 s.
   All requests emit standard `user` / `assistant` Messages API roles with change-only
   `<environment_context>` blocks (converting legacy persisted `latestReminder` CSVs on replay),
   strip historical `thinking` across completed turns (replaying in-progress `thinking` only when
   active provider and model match), and continue stopped / `max_tokens` prose replies via a
   standard hidden `user` continuation prompt (`CONTINUE_PROMPT`) rather than assistant prefill.
   When `provider.attachments` is present, attachments and tool screenshots upload remotely (with
   provider-owned invalidation re-uploads up to `fileReuploadLimit`); when absent, they travel
   inline as base64 blocks read from `blobs`. Pre-content network failures retry up to
   `networkRetryLimit` per turn with exponential backoff. Post-content failures do not retry and
   keep partial text. Streams ending after `message_delta` stop reason without `message_stop` count
   as complete.
9. **Deliverables & Front Stage.** Delivered files (`result.files`) deduplicate by `path ?? name`
   at latest version in first-seen order and appear once streaming ends. Tool `images` without
   `previewImages` promote to Front Stage (`view.images`); tools that supply clean `previewImages`
   keep their screenshots backstage in the Activity Inspector. `buildTurnWorkStrip` is driven solely
   by `ToolStepPresenter.summarize` and `result.frontStageNote`, emitting middot-free natural-language
   summaries (never appending thinking duration onto tool counts and never escalating recovered
   mid-turn tool errors into transcript-level warnings). `buildInlineTrace` and
   `selectInlineTracePreview` project domain-blind plain-prose steps (with optional `callId`,
   `lane`, and presenter-supplied `icon`, and without step numbers or per-step durations); bounded
   previews always retain currently running steps in chronological order, and clicking an inline
   trace row publishes `TurnInspectionRequested` with that step's `callId`.
10. **Living session titles.** After every completed reply (including Turn 1), if the title is
    unlocked, a detached cache-riding fork reuses the exact turn prefix (`model`, `system`, `tools`,
    `messages`) to name or refresh the session without altering `session.messages` or `updatedAt`.
    Any user mutation cancels an in-flight fork.
11. **Stream traces.** When `onStreamTrace` is provided, every request reports sizes and timings
    without message, tool input, or reply text.
12. **Branch-anchored conversation compaction.** Five triggers (`turnStart`, `betweenRounds`,
    `manual`, `fit`, `overflow`) funnel through one `runCompaction` pipeline governed by a
    window-adaptive policy derived from `ModelSpec` (interpolating smoothly from 70% line / 20K
    verbatim keep at <=200K windows to 50% line / 40K verbatim keep at >=1M windows, with output
    reserve capped at 10% of the window and strictly monotonic line scaling). Normal compactions
    ride the active `(model, system, tools, messages)` KV-cache prefix with thinking disabled;
    oversized spans fall back to bounded plain-text chunked folding (preserving prior checkpoint
    summaries). Summaries must validate (`Goal` + `Next Steps`, no tool calls, not truncated or
    refused); failed or aborted compactions leave existing context intact. Validated checkpoints
    store immutable `renderedWireText` anchored to `(anchorMessageId, afterBlockIndex?)` on
    `Session.checkpoints`, isolating branches completely while preserving original messages and
    attachments in storage. Capability-specific factual ledgers flow domain-blindly through
    `ToolRegistry.buildCompactionLedger`. Reactive `overflow` compaction retries at most once per
    turn on `contextOverflow` or `payloadTooLarge` errors.

13. **Transcript minimap & reading position.** Chats with two or more turns show a `Minimap` in a 64 px column at the
    transcript's right edge. The column is kept in every chat on desktop while the chat area is at least 640 px wide (so nothing moves when the minimap appears); the messages, the composer and the new-chat greeting centre in the space beside it, and in a narrower window or the mobile layout the column and the minimap go and everything centres in the full width. The minimap draws one section per turn (from each `data-turn-anchor`, its prompt bubble the marker) labelled by the prompt, with a divider after each compaction checkpoint. While the minimap is on screen the transcript's scrollbar is hidden (the map shows the reading position); when it hides, the scrollbar returns. The reading turn is the one whose start (its prompt, or the reply when it has none) is last above the reading line (`readingLineY`), which travels with scroll progress from the top of the view to its bottom, so every turn, however short, is current somewhere and the latest turn is current at the bottom; it is
    published through `getReadingPosition` after scrolling rests on it, and at once for navigation.
    Choosing a turn from the minimap's list, `⌥↑` / `⌥↓` (outside text fields), or a reveal glides the transcript so the
    turn starts 24 px below the top, holds that turn as the reading turn until the reader scrolls,
    and pulses the turn's prompt bubble on arrival. Clicking the map glides to that point; dragging its
    window scrolls directly.
    Jumps and drags longer than 1.2 viewports let `⌥←` return to the turn left behind, which
    clears once the reader is back there. Reveals publish with cause `'reveal'` and never offer a
    return; everything else is `'reader'`.

## Parameters

| Name                                        | Value                                             |
| :------------------------------------------ | :------------------------------------------------ |
| Loaded chat details kept in memory          | 5 (plus active, streaming and unsaved ones)       |
| Tool rounds per turn                        | 50 (`toolRoundLimit`)                             |
| Concurrent `read` calls per batch           | 6 (`maxParallelReadCalls`)                        |
| Network retries per turn                    | 2 (`networkRetryLimit`)                           |
| Re-uploads per request after a dropped file | 2 (`fileReuploadLimit`)                           |
| Backoff before retry n (from 0)             | 1 s × 2ⁿ (`retryBaseDelayMs`)                     |
| Attachments per message                     | 50                                                |
| Attachment size                             | 64 MB                                             |
| Concurrent uploads                          | 3                                                 |
| Compaction line scaling                     | 70% at <=200K -> 50% at >=1M (`ModelSpec`)        |
| Verbatim dialogue retention budget          | 20K at <=200K -> 40K at >=1M (<=25% window)       |
| Stall delay before "Working…"               | 1.5 s                                             |
| Inline trace preview cap                    | 6 steps (`INLINE_TRACE_PREVIEW_LIMIT`)            |
| Reading line                                | moves with scroll progress, top of view to bottom |
| Reading position settle delay               | 100 ms                                            |
| Return offered after a jump of              | 1.2 viewports                                     |
| Space above a turn after jumping to it      | 24 px                                             |
