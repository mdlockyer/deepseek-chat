# SPEC: `slices/activity-inspector` (first-class right-hand Activity & Sources inspector)

## Purpose

Hosts the right-hand Activity & Sources workbench inside the app's shared `PanelSlot`, with a
first-class `HeaderToggle` in the session header alongside peer workspace toggles. Operates in
either `follow_latest` mode (tracking the latest or currently streaming turn) or `pinned` mode
(inspecting a specific turn via `TurnInspectionRequested` or the turn switcher, with a visible
`Follow latest` escape hatch when pinned behind a newer turn). Reads live reply snapshots via
`TurnSnapshotSource`, renders one unified scannable step-row grammar across all capabilities
(preferring each tool call's plain-prose `summary` so left and right panes match verbatim),
delegates expanded step bodies to each capability's `ToolStepPresenter.renderStepDetail` (with
optional `renderActivity` support for custom plugins and a generic fallback when unmounted), pins
Reasoning at the top of the timeline, offers staged artifact filtering (`All` / `Visuals` /
`Errors`), and lists cited vs. other sources in accessible `lib-ui` `Tabs`.

## Public entrypoint

`createActivityInspectorSlice(deps)` returns:

| Member                           | Meaning                                                                                                                 |
| :------------------------------- | :---------------------------------------------------------------------------------------------------------------------- |
| `ActivityPanel({ topActions? })` | Unified two-tab (`Activity` \| `Sources`) right-hand workbench with turn context, staged filters, and unified timeline. |
| `HeaderToggle`                   | Session header toggle button (always visible peer alongside Browser and File Preview).                                  |
| `togglePanel(sessionId)`         | Opens Activity in `follow_latest` mode (or restores the pinned turn on that session); toggles closed when already open. |
| `selectTurn(sessionId, msgId)`   | Pins a specific turn inside the open Activity panel.                                                                    |
| `followLatest(sessionId)`        | Switches an open pinned Activity panel back to `follow_latest` mode on the active session.                              |
| `useActiveTarget()`              | React hook returning the actively displayed pinned `ActivityTarget \| null` (`null` while hidden/displaced).            |
| `getTarget()`                    | Imperative getter matching `useActiveTarget()`.                                                                         |
| `getSelection()`                 | Current `ActivitySelection \| null` (`'follow_latest' \| 'pinned'`).                                                    |
| `close()`                        | Closes the panel slot and clears selection.                                                                             |
| `dispose()`                      | Unsubscribes all `EventLog` and `PanelSlot` listeners.                                                                  |

Pure exports: `buildActivityTimeline`, `extractTurnSources`, `SiteLogo`, `SourceCard`.

## Behavioural invariants

1. **First-class header toggle & mode honesty.** Clicking `HeaderToggle` opens Activity in
   `follow_latest` mode (showing the currently streaming turn or latest turn with activity, or a
   structured `EmptyState` on a brand-new chat) and closes it when already open. Whenever the panel
   is pinned to an earlier turn while a newer turn has activity, a `Follow latest` control returns
   the panel to `follow_latest` mode.
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
4. **Zero sibling coupling, human step parity, & smart disclosure defaults.** Tool steps are
   summarized via `ToolStepPresenter.summarize` and always prefer `call.input.summary` as the row
   label so inline traces and Activity rows stay verbatim aligned. Steps marked `hiddenInTimeline`
   fold out. Presenters implementing `renderStepDetail` render inside the panel's single unified
   row chrome (consistent icon, metadata, accessible non-color-only error state, right chevron,
   `HoverGlide`, and >= 32 px / 44 px touch targets); unmounted capabilities fall back to the
   generic detail view. Tool steps and server search start collapsed by default and expand on click
   or when `focusedCallId` targets them. Reasoning is pinned at the top of the Activity tab, starts
   expanded on thinking-only turns (where it is the only content), and starts collapsed on turns
   that also have tool steps.
5. **Staged artifact views & accessible navigation.** `Activity` / `Sources` navigation uses
   `@deepseek-chat/lib-ui` `Tabs` (`tablist`, arrow-key roving `tab`, linked `tabpanel`). When a
   turn contains visual artifacts or errors, staged filter chips surface a direct visual storyboard
   (`Visuals`) with expanded descriptive-`alt` imagery and an auto-expanded `Errors` view.
6. **Sources ordering.** Deduplicated sources preserve first-seen 1-based citation numbers; the
   `Sources` tab lists cited sources first followed by all remaining uncited sources.
7. **Multi-instance isolation.** All Zustand state and subscriptions live inside the factory closure.
8. **Snapshot stability.** `ActivityPanel` stabilizes `TurnSnapshot` references across identical
   `useSyncExternalStore` reads so a `TurnSnapshotSource` that wraps fields in fresh objects cannot
   trigger an infinite render loop.

## Facts

Consumes `ActiveSessionChanged`, `SessionDeleted`, `SessionHistoryReplaced`,
`TurnInspectionRequested`. Publishes none.
