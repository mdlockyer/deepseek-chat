# SPEC: `slices/activity-inspector` (right-hand Activity & Sources evidence drawer)

## Purpose

Hosts the right-hand Activity & Sources evidence drawer inside the app's shared `PanelSlot`, with
a first-class `HeaderToggle` in the session header alongside peer workspace toggles. The drawer
scrolls through every turn of the chat as chapters, each under a sticky header naming the turn by
its prompt, and stays in step with the transcript: in `follow_reading` mode it shows the turn the
reader is on (from the optional `transcript` port; the latest turn without one), and in `pinned`
mode it holds one turn (from `TurnInspectionRequested`, the header's previous / next buttons, or a
chapter header) until the reader moves on to another turn in the transcript. The drawer scrolls
itself only when it is first shown and when the reader pins a turn; the reader moving through the
transcript never scrolls it, and scrolling the drawer never scrolls the transcript. A header readout
names the turn at the drawer's reading line (or the turn just pinned), and a round chevron button at the bottom of the drawer
scrolls the drawer to its bottom.

Rather than duplicating the left chat pane's step list under stacked filter bars, the drawer keeps
**one single 52px header** (with underline `Activity` | `Sources` tabs when sources exist), pins an
**Outputs strip** at the top of the scrollable body whenever files, charts, or screenshots were
produced (opening generated files in File Preview and opening visuals in a native `Dialog`
lightbox), groups multi-round **Reasoning** inside a single top disclosure with per-round causal
step links, folds inter-tool model narration prose inside each step's expanded detail, and renders
one unified scannable step-row grammar across all capabilities (marking failed tool calls quietly
via a danger-tinted step icon so users can expand the row for details without loud top-level error
banners).

## Public entrypoint

`createActivityInspectorSlice(deps)` returns:

| Member                           | Meaning                                                                                                             |
| :------------------------------- | :------------------------------------------------------------------------------------------------------------------ |
| `ActivityPanel({ topActions? })` | Single-header right-hand Activity & Sources drawer with Evidence Shelf, Visual Lightbox, and unified step timeline. |
| `HeaderToggle`                   | Session header toggle button (always visible peer alongside Browser and File Preview, with >= 3:1 active ring).     |
| `togglePanel(sessionId)`         | Opens Activity in `follow_reading` mode (or restores the pinned turn on that session); toggles closed when open.    |
| `selectTurn(sessionId, msgId)`   | Pins a turn in the open panel and asks the transcript (`revealTurn`) to show it too.                                |
| `useActiveTarget()`              | React hook returning the currently displayed `ActivityTarget \| null` in both `follow_reading` and `pinned` modes.  |
| `getTarget()`                    | Imperative getter matching `useActiveTarget()` (`null` while hidden, displaced, or showing no active turn).         |
| `getSelection()`                 | Current `ActivitySelection \| null` (`'follow_reading' \| 'pinned'`).                                               |
| `close()`                        | Closes the panel slot and clears selection.                                                                         |
| `dispose()`                      | Unsubscribes all `EventLog` and `PanelSlot` listeners.                                                              |

Pure exports: `buildActivityTimeline`, `extractTurnSources`, `SiteLogo`, `SourceCard`.

Optional port `transcript: TranscriptPort` (`getReadingPosition`, `subscribeToReading`, `revealTurn`),
wired by the app to `slices/conversations`. Without it the drawer follows the latest
turn and scrolling it moves nothing else.

## Behavioural invariants

1. **First-class header toggle, following the reader & active target honesty.** Clicking
   `HeaderToggle` opens Activity in `follow_reading` mode and closes it when already open. In
   `follow_reading` the displayed turn is the transcript's reading position when that turn is in
   the chat, else the streaming turn, else the latest turn; a brand-new chat shows a calm
   `EmptyState`. `useActiveTarget()` / `getTarget()` report the resolved `{ sessionId, messageId,
tab }` in both modes while open, and `null` while closed or displaced. Whenever the visible tab
   is more than 48px from its bottom, a round chevron button floats at the bottom of the panel and
   glides that tab to its bottom; it never moves the transcript. A pulsing dot marks it while the
   latest turn streams, and a keyboard user who presses it lands on the last turn's heading.
2. **Turn pinning, chapters & persistent step targeting.** `TurnInspectionRequested` pins
   `(sessionId, messageId, tab)` and opens the panel slot. When `callId` is omitted, a request for
   the turn and tab the open panel already displays (pinned or followed) toggles it closed. When
   `callId` is provided, the panel always opens (or stays open), records `focusedCallId` with a
   monotonically bumped `focusNonce`, expands the targeted step, glides it into view below its
   chapter header, and keeps a persistent selected indicator on that step until another step is
   chosen or focus is cleared. A pin holds until the transcript reports a different reading turn
   with cause `'reader'`; positions with cause `'reveal'` never release it. Both tabs render every
   turn (Sources: every turn with sources) as a chapter under a sticky header with its number, prompt
   and a step count, source count or live marker, each keeping its own expanded steps. When the
   tab is first shown it jumps to the displayed turn's chapter (to the bottom while a live latest
   turn streams), and when the reader pins a turn it glides there. The displayed turn changing
   because the reader moved in the transcript (or let go of a pin) does not scroll the drawer. While
   the visible tab sits at its bottom and the latest turn streams, new steps keep it at the bottom.
   The chapter under the drawer's reading line (`readingLineY`, which stays at the middle of the view through most of a scroll and eases to the top and bottom edges at the ends, so every chapter is reachable and the switch happens at the same place on screen) is marked current (its title turns from secondary to primary text) and named in the readout, when the tab is first shown and as the reader scrolls it; a pinned turn is marked current until the reader scrolls the drawer, and stays marked when the pin is let go. The header readout ("Turn 3 of 9") shows only while it fits beside the tabs, so it never runs under the header buttons in a narrow panel; screen readers always get the full readout. Previous / next header buttons pin
   the turn in the drawer only; chapter headers pin the turn and reveal it in the transcript.
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
5. **Outputs strip, Lightbox, & quiet failed steps (zero mode switching).** Mid-turn tool errors are
   routine in agentic turns and stay quiet in the collapsed timeline: a failed step tints its tool
   icon (`--ui-text-danger`) with screen-reader `(Failed)` status and reveals the full error detail
   when expanded, without promoting an error banner above the timeline. When a turn delivers files
   (`result.files`, deduplicated by path/name in first-seen order at the latest version) or captures
   visual artifacts, a unified `Outputs (N)` horizontal strip renders above the timeline: clicking a
   file opens it via `openFile` (File Preview), and clicking a visual thumbnail or expanded-step
   visual opens a native `Dialog` lightbox with keyboard prev/next navigation, descriptive external
   link, and `"Show step"`.
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

## Parameters

| Name                                 | Value  |
| :----------------------------------- | :----- |
| Reader-scroll window after input     | 250 ms |
| Live turn keeps the drawer at bottom | 48 px  |
