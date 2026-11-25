# SPEC: `slices/activity-inspector` (right-hand Activity & Sources evidence drawer)

## Purpose

Hosts the right-hand Activity & Sources evidence drawer inside the app's shared `PanelSlot`, with
a first-class `HeaderToggle` in the session header alongside peer workspace toggles. Operates in
either `follow_latest` mode (tracking the latest or currently streaming turn) or `pinned` mode
(inspecting a specific turn via `TurnInspectionRequested` or the header turn menu, with a compact
`Latest` return button when pinned behind a newer turn).

Rather than duplicating the left chat pane's step list under stacked filter bars, the drawer keeps
**one single 52px header** (with underline `Activity` | `Sources` tabs when sources exist), pins an
**Evidence Shelf** at the top of the scrollable body (jumpable error summary callout + clickable
horizontal thumbnail filmstrip opening a full-size native `Dialog` lightbox), groups multi-round
**Reasoning** inside a single top disclosure with per-round causal step links, folds inter-tool
model narration prose inside each step's expanded detail, and renders one unified scannable
step-row grammar across all capabilities.

## Public entrypoint

`createActivityInspectorSlice(deps)` returns:

| Member                           | Meaning                                                                                                             |
| :------------------------------- | :------------------------------------------------------------------------------------------------------------------ |
| `ActivityPanel({ topActions? })` | Single-header right-hand Activity & Sources drawer with Evidence Shelf, Visual Lightbox, and unified step timeline. |
| `HeaderToggle`                   | Session header toggle button (always visible peer alongside Browser and File Preview, with >= 3:1 active ring).     |
| `togglePanel(sessionId)`         | Opens Activity in `follow_latest` mode (or restores the pinned turn on that session); toggles closed when open.     |
| `selectTurn(sessionId, msgId)`   | Pins a specific turn inside the open Activity panel.                                                                |
| `followLatest(sessionId)`        | Switches an open pinned Activity panel back to `follow_latest` mode on the active session.                          |
| `useActiveTarget()`              | React hook returning the currently displayed `ActivityTarget \| null` in both `follow_latest` and `pinned` modes.   |
| `getTarget()`                    | Imperative getter matching `useActiveTarget()` (`null` while hidden, displaced, or showing no active turn).         |
| `getSelection()`                 | Current `ActivitySelection \| null` (`'follow_latest' \| 'pinned'`).                                                |
| `close()`                        | Closes the panel slot and clears selection.                                                                         |
| `dispose()`                      | Unsubscribes all `EventLog` and `PanelSlot` listeners.                                                              |

Pure exports: `buildActivityTimeline`, `extractTurnSources`, `SiteLogo`, `SourceCard`.

## Behavioural invariants

1. **First-class header toggle & active target honesty.** Clicking `HeaderToggle` opens Activity in
   `follow_latest` mode (showing the currently streaming turn or latest turn with activity, or a
   calm `EmptyState` on a brand-new chat) and closes it when already open. `useActiveTarget()` /
   `getTarget()` reports the resolved displayed `{ sessionId, messageId, tab }` in both
   `follow_latest` and `pinned` modes while open, and `null` while closed or displaced. Whenever
   pinned behind a newer turn, a header `Latest` control returns to `follow_latest` mode.
2. **Turn pinning & persistent step targeting.** `TurnInspectionRequested` pins
   `(sessionId, messageId, tab)` and opens the panel slot. When `callId` is omitted, repeating the
   exact same pinned request while open toggles closed. When `callId` is provided, the panel always
   opens (or stays open), records `focusedCallId` with a monotonically bumped `focusNonce`, expands
   the targeted step, scrolls it into view, and keeps a persistent selected indicator on that step
   until another step is chosen or focus is cleared.
3. **Displacement isolation.** When another right-hand panel displaces Activity on the same
   session, `useActiveTarget()` / `getTarget()` reports `null` while hidden, and clicking
   `HeaderToggle` again resumes that session's selection (clearing any stale `focusedCallId`).
   Switching chats (`ActiveSessionChanged`), deleting the chat (`SessionDeleted`), or replacing
   history (`SessionHistoryReplaced`) cleans up non-matching selection state.
4. **Zero sibling coupling, folded narration, & round-grouped reasoning.** Tool steps are
   summarized via `ToolStepPresenter.summarize` and prefer `call.input.summary` as the row label so
   left and right panes stay aligned. Steps marked `hiddenInTimeline` fold out without consuming
   preceding narration or reasoning links. Inter-tool model `text` blocks fold onto the following
   visible step as `precedingNote` (shown inside the step's expanded detail, never duplicating the
   collapsed timeline). Multi-round `thinking` blocks live inside a single top Reasoning disclosure
   (expanded on thinking-only turns, collapsed on tool turns) with causal links to the step each
   round led into.
5. **Evidence Shelf & Visual Lightbox (zero mode switching).** When a turn has failed steps, a
   compact error callout at the top of the body previews the failure and jumps directly to and
   expands the failed step (which stays genuinely collapsible). When a turn captures visual
   artifacts, a clickable horizontal thumbnail filmstrip renders above the timeline; clicking any
   filmstrip thumbnail or expanded-step visual opens a native `Dialog` lightbox with keyboard
   prev/next navigation, descriptive external link, and `"Show step"`.
6. **Stable mount across `Sources` transitions & accessible navigation.** `Activity` / `Sources`
   navigation uses `@deepseek-chat/lib-ui` `Tabs` (`variant="underline"`, `keepMounted`). The
   Activity scroll container stays mounted at one stable tree position when `hasSources` changes
   mid-stream or when switching tabs, preserving scroll position and expanded state, while keeping
   an accessible `<h2>` panel heading in both tabbed and single-view modes.
7. **Sources ordering.** Deduplicated sources preserve first-seen 1-based citation numbers; the
   `Sources` tab lists cited sources first followed by all remaining uncited sources.
8. **Multi-instance isolation & snapshot stability.** All Zustand state and subscriptions live
   inside the factory closure. `ActivityPanel` stabilizes `TurnSnapshot` references across
   identical `useSyncExternalStore` reads, and scopes live streaming 1s timers strictly to active
   duration leaves so `buildActivityTimeline` never recomputes on idle ticks.

## Facts

Consumes `ActiveSessionChanged`, `SessionDeleted`, `SessionHistoryReplaced`,
`TurnInspectionRequested`. Publishes none.
