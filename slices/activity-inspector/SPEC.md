# SPEC: `slices/activity-inspector` (unified right-hand Turn Activity & Sources inspector)

## Purpose

Hosts the right-hand Turn Activity & Sources panel inside the app's shared `PanelSlot`. Tracks
which turn is being inspected per instance, reads live reply snapshots via `TurnSnapshotSource`,
coalesces consecutive tool steps by capability lane, delegates rendering to each capability slice's
`ToolStepPresenter` (with a graceful generic fallback when a capability slice is not installed),
and displays cited vs. other sources cleanly.

## Public entrypoint

`createActivityInspectorSlice(deps)` returns:

| Member                           | Meaning                                                                                 |
| :------------------------------- | :-------------------------------------------------------------------------------------- |
| `ActivityPanel({ topActions? })` | Unified two-tab (`Activity` \| `Sources`) right-hand panel view.                        |
| `useActiveTarget()`              | React hook returning the currently open `ActivityTarget \| null`.                       |
| `useHasLastActivity()`           | React hook indicating whether the displaced target can be restored for the active chat. |
| `restoreLastActivity()`          | Restores the last displaced target on the active chat and re-opens the panel slot.      |
| `close()`                        | Closes the panel slot and clears the active target.                                     |
| `dispose()`                      | Unsubscribes all `EventLog` and `PanelSlot` listeners.                                  |

Pure exports: `buildActivityTimeline`, `extractTurnSources`.

## Behavioural invariants

1. **Fact-driven open/toggle.** `TurnInspectionRequested` toggles closed when the same
   `(sessionId, messageId, tab)` is already open; otherwise opens the panel slot on that turn/tab.
2. **Displacement memory.** When another right-hand panel displaces Activity on the same session,
   `lastTarget` is preserved so `restoreLastActivity()` reopens it in one click. Switching chats
   (`ActiveSessionChanged`), deleting the chat (`SessionDeleted`), or replacing history
   (`SessionHistoryReplaced`) clears the matching target cleanly.
3. **Zero sibling coupling.** Tool steps are grouped by `ToolStepSummary.lane` and rendered through
   the owning capability's `ToolStepPresenter`. Steps marked `hiddenInTimeline` fold out; steps
   whose capability slice is unmounted render via the built-in generic fallback view.
4. **Sources ordering.** Deduplicated sources preserve first-seen 1-based citation numbers; the
   `Sources` tab lists cited sources first followed by all remaining uncited sources.
5. **Multi-instance isolation.** All Zustand state and subscriptions live inside the factory closure.
6. **Snapshot stability.** `ActivityPanel` stabilizes `TurnSnapshot` references across identical `useSyncExternalStore` reads so a `TurnSnapshotSource` that wraps fields in fresh objects cannot trigger an infinite render loop.

## Facts

Consumes `ActiveSessionChanged`, `SessionDeleted`, `SessionHistoryReplaced`,
`TurnInspectionRequested`. Publishes none.
