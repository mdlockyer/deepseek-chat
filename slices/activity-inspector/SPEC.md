# SPEC: `slices/activity-inspector` (first-class right-hand Activity & Sources inspector)

## Purpose

Hosts the right-hand Activity & Sources workspace panel inside the app's shared `PanelSlot`, with a
first-class `HeaderToggle` in the session header alongside peer workspace toggles. Operates in
either `follow_latest` mode (when opened from the header, automatically tracking the latest or
currently streaming turn with a turn switcher for multi-turn chats) or `pinned` mode (when opened
for a specific turn via `TurnInspectionRequested` or the turn switcher). Reads live reply snapshots
via `TurnSnapshotSource`, coalesces consecutive tool steps by capability lane, delegates rendering
to each capability slice's `ToolStepPresenter` (with a generic fallback when unmounted), and lists
cited vs. other sources.

## Public entrypoint

`createActivityInspectorSlice(deps)` returns:

| Member                           | Meaning                                                                                                                 |
| :------------------------------- | :---------------------------------------------------------------------------------------------------------------------- |
| `ActivityPanel({ topActions? })` | Unified two-tab (`Activity` \| `Sources`) right-hand panel with multi-turn switcher.                                    |
| `HeaderToggle`                   | Session header toggle button (always visible peer alongside Browser and File Preview).                                  |
| `togglePanel(sessionId)`         | Opens Activity in `follow_latest` mode (or restores the pinned turn on that session); toggles closed when already open. |
| `selectTurn(sessionId, msgId)`   | Pins a specific turn inside the open Activity panel.                                                                    |
| `useActiveTarget()`              | React hook returning the actively displayed pinned `ActivityTarget \| null` (`null` while hidden/displaced).            |
| `getTarget()`                    | Imperative getter matching `useActiveTarget()`.                                                                         |
| `getSelection()`                 | Current `ActivitySelection \| null` (`'follow_latest' \| 'pinned'`).                                                    |
| `close()`                        | Closes the panel slot and clears selection.                                                                             |
| `dispose()`                      | Unsubscribes all `EventLog` and `PanelSlot` listeners.                                                                  |

Pure exports: `buildActivityTimeline`, `extractTurnSources`, `SiteLogo`, `SourceCard`.

## Behavioural invariants

1. **First-class header toggle.** Clicking `HeaderToggle` opens Activity in `follow_latest` mode
   (showing the currently streaming turn or latest turn with activity, or an explanatory empty
   state on a brand-new chat) and closes it when already open.
2. **Turn pinning.** `TurnInspectionRequested` pins `(sessionId, messageId, tab)` and opens the
   panel slot; repeating the exact same pinned request while open toggles closed.
3. **Displacement isolation.** When another right-hand panel displaces Activity on the same
   session, `useActiveTarget()` / `getTarget()` reports `null` while hidden, and clicking
   `HeaderToggle` again resumes that session's selection. Switching chats (`ActiveSessionChanged`),
   deleting the chat (`SessionDeleted`), or replacing history (`SessionHistoryReplaced`) cleans up
   non-matching selection state.
4. **Zero sibling coupling.** Tool steps are grouped by `ToolStepSummary.lane` and rendered through
   the owning capability's `ToolStepPresenter`. Steps marked `hiddenInTimeline` fold out; steps
   whose capability slice is unmounted render via the built-in generic fallback view.
5. **Sources ordering.** Deduplicated sources preserve first-seen 1-based citation numbers; the
   `Sources` tab lists cited sources first followed by all remaining uncited sources.
6. **Multi-instance isolation.** All Zustand state and subscriptions live inside the factory closure.
7. **Snapshot stability.** `ActivityPanel` stabilizes `TurnSnapshot` references across identical
   `useSyncExternalStore` reads so a `TurnSnapshotSource` that wraps fields in fresh objects cannot
   trigger an infinite render loop.

## Facts

Consumes `ActiveSessionChanged`, `SessionDeleted`, `SessionHistoryReplaced`,
`TurnInspectionRequested`. Publishes none.
