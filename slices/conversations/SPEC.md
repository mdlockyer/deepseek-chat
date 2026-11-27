# SPEC: `slices/conversations` (chats with DeepSeek)

## Purpose

Core chat domain: sessions and branching message trees, streaming replies, the domain-blind
client-tool loop, attachments and drafts, the DeepThink composer toggle, factory-scoped session
persistence, chat views, and the built-in Activity & Sources inspector.

Depth-2 layout: pure `kernel/` (types, session lifecycle & LRU eviction reducer, branch tree, reply
wire assembly, compaction policy, attachments/drafts rules, environment context, auto-title,
reading contracts, messages) ← five isolated cells (`cells/storage/`, `cells/compaction/`,
`cells/turn-loop/`, `cells/views/`, `cells/activity-inspector/`) ← thin `src/runtime.ts` and
`src/index.ts`. Sibling capabilities plug in through `@deepseek-chat/lib-tools`, Spine `EventLog`
facts, Tier-`1c` `@deepseek-chat/lib-chat-archive-contract`, and optional view ports.

## Public entrypoint

`createConversationsSlice(deps)` creates an isolated multi-instance slice and returns:

| Member                                                                 | Meaning                                                                                                                                                                                                                                     |
| :--------------------------------------------------------------------- | :------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `stopReply(sessionId)`                                                 | Stops that chat's in-flight reply or manual compaction.                                                                                                                                                                                     |
| `commands`                                                             | Headless commands: `init`, `newChat`, `selectSession`, `renameSession`, `removeSession`, `setDraft`, `attach`, `send`, `regenerate`, `continueReply`, `edit`, `selectVersion`, `compact`, `whenIdle`.                                       |
| `getState()`, `subscribe(listener)`                                    | Session summaries (newest first), `activeId`, `ready`, `replying` session IDs, and change subscription.                                                                                                                                     |
| `getThinking()`, `setThinking(enabled)`                                | Instance-scoped DeepThink toggle (`chat-demo:thinking`).                                                                                                                                                                                    |
| `getChatMessages(id)`, `getChatCheckpoints(id)`, `useChatMessages(id)` | Loaded chat's visible branch and stored compaction checkpoints (empty while unloaded).                                                                                                                                                      |
| `getTurnSnapshot(sid, mid)`                                            | Referentially stable read-only live turn snapshot for a loaded assistant reply.                                                                                                                                                             |
| `activity`, `ActivityPanel({ topActions? })`                           | Built-in Activity & Sources inspector cell (non-null when `activityPanel` is provided): `togglePanel`, `inspectTurn`, `selectTurn`, `useActiveTarget`, `getSelection`, `getTarget`, `close`, reading position hooks, and right-hand drawer. |
| `snapshotForExport()`, `replaceSessions(fn)`                           | Atomic storage ports consumed by `slices/history-backup` via Tier-`1c` contract.                                                                                                                                                            |
| `useHistoryState()`, `describeReplyNotice(msg)`                        | History replacement/empty state and localized reply error/template text.                                                                                                                                                                    |
| `useChatLifecycle()`, `useActiveSessionId()`                           | Lifecycle hooks for upload notices, persistence flush, mobile drawer, and init.                                                                                                                                                             |
| `Sider`, `MobileSider`, `SiderToolbar`                                 | Session-list views. `SiderToolbar` is one element traveling with the desktop sidebar (`collapsed` \| `expanded`, showing `+` only while collapsed); the mobile drawer keeps its own toggle.                                                 |
| `ChatMain({ siderMode })`, `ChatSaveBanner`                            | Main chat/welcome view (`siderMode`: `'absent' \| 'collapsed' \| 'expanded'`), top-right Settings trigger, and save-failure banner.                                                                                                         |
| `dispose()`                                                            | Aborts active streams, cancels timers, unsubscribes from `EventLog`, closes owned DB handle.                                                                                                                                                |

Documented pure-model exports: branch tree (`appendBranch`, `getVisibleMessages`, `normalizeSession`,
`selectVersion`), reply/wire helpers (`CONTINUE_PROMPT`, `applyEvent`, `canContinueReply`,
`findActiveCheckpoint`, `pickImageResults`, `settleReply`, `toRequestMessages`,
`formatLegacyLatestReminder`), compaction policy & validation (`CHECKPOINT_ACK`,
`computeCompactionPolicy`, `selectCompactionTrigger`, `buildCompactionLedgerText`,
`buildVerbatimSection`, `estimateSessionContext`, `estimateTextTokens`,
`validateCompactionSummary`), view/activity projections (`buildReplyView`, `buildTurnWorkStrip`,
`buildInlineTrace`, `selectInlineTracePreview`, `buildActivityTimeline`, `extractTurnSources`,
`getAreaTitle`, `getFrontStageNotes`, `holdsNarration`, `needsWorkingIndicator`), and
`createIndexedDbSessionStore`.

## Ports (`ConversationsDeps`)

`log` (`EventLog`), `provider` (`ModelProvider`), `store` (`KeyValueStore` for
`chat-demo:thinking`), `blobs` (`BlobStore`), optional `sessions` (`SessionStore`, defaults to
IndexedDB `deepseek-sessions`), optional `tools` (`ToolRegistry`), optional `activityPanel`
(`PanelSlot`), `platform` (`'desktop' | 'web'`), `getLocationLabel`, optional `onStreamTrace`,
`autoTitle` (default `true`), optional `notify` (`NoticePort`), and optional `ui` view slots.

## Spine facts

- **Publishes (sticky):** `ActiveSessionChanged` (key `'unit'`), `SessionFilesChanged` (key `sessionId`, tombstoned on delete/replace).
- **Publishes (discrete):** `ReplyLifecycleChanged`, `ToolFileDelivered`, `SessionDeleted`, `SessionHistoryReplaced`.
- **Subscribes:** `BrowserControlTakenOver` (aborts active reply for that session).

## Behavioural invariants

1. **Multi-instance isolation.** Every store, draft map, upload queue, auto-title controller, and DB
   handle is scoped to the slice instance; `dispose()` aborts streams and detaches all listeners.
2. **Storage & lifecycle facts.** Deleting a session removes it from storage, tombstones its
   `SessionFilesChanged`, and publishes `SessionDeleted` once. Replacing history tombstones all
   `SessionFilesChanged` entries and publishes `SessionHistoryReplaced` once. Failed deletes or
   replacements publish nothing and leave state intact.
3. **Domain-blind tool loop.** Tool calls run once via `tools.run` in call order, scheduled by
   `tools.effectOf(name)`: consecutive `read` calls run concurrently up to `maxParallelReadCalls`,
   `spawn` returns immediately, and `session`/`artifact`/`interactive` run serially. Running blocks
   carry `status: 'running'` and optional `progress`; concurrent `read` batches reconcile citations
   in call order via `formatContentWithCitations`. Abort cancels queued calls cleanly.
4. **Turn lifecycle hooks.** `onTurnEndWithoutToolCalls` may inject a synthetic tool call (bounded
   by `toolRoundLimit`); `onTurnSettled` runs on `done`/`user`/`interrupted`/`roundLimit`;
   `onReplyHydrated` normalizes persisted `capabilityState[id]`.
5. **Static prompt.** `system` is the core assistant identity plus `tools.instructions(names, 'reply')`,
   free of em dashes and identical across turns with the same declared tools for KV-cache reuse.
6. **Composer & DeepThink.** DeepThink persists under `chat-demo:thinking`; sibling toggles come
   from `tools.toggles`. The composer holds only draft/attachments/send-stop; `+` (upload &
   compaction) and the tools pill open as corner-anchored `MorphMenu`s with no context meter.
7. **Branches.** Messages form a tree: send appends to the visible leaf; edit/regenerate create
   sibling branches; switching versions updates `selectedChildId` and re-publishes
   `SessionFilesChanged`.
8. **Requests, attachments, & retries.** All requests use standard `user`/`assistant` roles with
   change-only `<environment_context>`, strip historical `thinking` across completed turns, and
   continue stopped/`max_tokens` prose via hidden `user` `CONTINUE_PROMPT`. Attachments and tool
   screenshots upload remotely when `provider.attachments` exists (re-uploading invalidated IDs up
   to `fileReuploadLimit`) or travel inline as base64 otherwise. Pre-content network failures retry
   with exponential backoff up to `networkRetryLimit`; post-content failures keep partial text.
   Localized network errors (such as `requestTimedOut`) surface via `describeReplyNotice`.
9. **Front Stage & inline trace.** Delivered files deduplicate by `path ?? name` at latest version
   in first-seen order once streaming ends. Tool `images` promote to Front Stage only when no
   `previewImages` exist. `buildTurnWorkStrip` produces middot-free summaries from
   `ToolStepPresenter.summarize` and `frontStageNote` without escalating recovered mid-turn errors.
   Post-tool streaming text is held briefly (`holdsNarration`) so mid-turn narration does not flash as
   the final answer. Bounded inline traces retain running steps chronologically and open the
   Activity inspector focused on the clicked `callId`.
10. **Living session titles.** After each completed reply on an unlocked title, a detached
    cache-riding fork reuses `(model, system, tools, messages)` without mutating messages or
    `updatedAt`; any user mutation aborts an in-flight fork.
11. **Stream traces.** `onStreamTrace` reports sizes and timings without prompt or reply text.
12. **Branch-anchored compaction.** Five triggers (`turnStart`, `betweenRounds`, `manual`, `fit`,
    `overflow`) share one pipeline governed by a monotonic `ModelSpec` window policy. Normal
    compactions ride the active KV-cache prefix with thinking off; oversized spans chunk-fold while
    preserving prior checkpoints. Summaries must validate (`Goal` + `Next Steps`, no tool calls, no
    truncation/refusal); failed/aborted runs leave context intact. Checkpoints anchor to
    `(anchorMessageId, afterBlockIndex?)` on `Session.checkpoints`, isolating branches and pulling
    factual ledgers via `ToolRegistry.buildCompactionLedger`. Reactive `overflow` retries at most
    once per turn.
13. **Transcript minimap & reading position.** Desktop chats with `>= 2` turns and `>= 640 px` width
    show a 64 px `Minimap` gutter (reserving the column so content never shifts, hiding the native
    scrollbar while visible, collapsing on narrow/mobile layouts) with one section per turn, coral
    prompt markers, and checkpoint dividers. `readingLineY` eases top → middle → bottom across
    scroll progress so every turn becomes current somewhere; `getReadingPosition` publishes after
    scroll settles and immediately on navigation. Minimap/keyboard (`⌥↑`/`⌥↓`)/reveal jumps glide to
    24 px below top, pulse the prompt, and offer `⌥←` return on reader jumps longer than 1.2
    viewports (`cause: 'reveal'` never offers a return).
14. **Activity & Sources inspector (`cells/activity-inspector/`).** `PanelSlot` is the sole owner of
    open/closed state (zero shadow `panelOpen`). Header toggle opens in `follow_reading` mode;
    explicit inspection pins `(sessionId, messageId, tab)` until a reader scroll changes turn
    (`'reveal'` never releases a pin). Untargeted clicks on the displayed turn/tab toggle closed;
    `callId`-targeted clicks stay open, bump `focusNonce`, and expand/select the step. Displacement
    makes `getTarget()` report `null` while hidden and resumes without stale `focusedCallId` on
    re-open. `buildActivityTimeline` coalesces lanes, links multi-round thinking, promotes outputs
    to an `Outputs (N)` strip + lightbox, keeps failed steps quiet, keeps tabs mounted via `hidden`,
    and orders cited sources ahead of uncited ones.

## Parameters

| Name                                             | Default                                           |
| :----------------------------------------------- | :------------------------------------------------ |
| Loaded chat details in memory (LRU)              | `5` (plus active, streaming, and unsaved)         |
| Tool rounds per turn (`toolRoundLimit`)          | `50`                                              |
| Concurrent `read` calls (`maxParallelReadCalls`) | `6`                                               |
| Network retries / file re-uploads per turn       | `2` / `2` (`retryBaseDelayMs`: 1 s × 2ⁿ)          |
| Attachments per message / size / concurrency     | `50` / `64 MB` / `3`                              |
| Compaction line / verbatim retention             | `70%` / `20K` (`<=200K`) → `50%` / `40K` (`>=1M`) |
| Narration hold / stall "Working…" delay          | `280 chars` or `1.2 s` / `1.5 s`                  |
| Inline trace preview cap                         | `6` steps                                         |
| Reading settle / jump offset / return span       | `100 ms` / `24 px` / `1.2` viewports              |
| Activity scroll window / live bottom lock        | `250 ms` / `48 px`                                |
