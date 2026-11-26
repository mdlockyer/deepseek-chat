# SPEC: `libs/ui` (Sealed Domain-Blind Component Kit)

## Purpose

A zero-dependency, domain-blind React component kit implementing the visual system defined by
`spine/design/tokens.css`. Every slice, UI library, and the App Shell consumes `@deepseek-chat/lib-ui`
through its single `.` entrypoint. No domain nouns, no slice imports, and no global mutable UI
singletons belong here.

This package is designed for **clean-slate regeneration**: deleting `libs/ui/src/*` and regenerating
it from this `SPEC.md`, `spine/design/tokens.css`, `spine/ports`, and `libs/ui/tests/` must restore
every slice's UI and pass the full gate with zero slice edits.

## Public Entrypoint (`@deepseek-chat/lib-ui`)

| Category                | Exports                                                                                                                                                                                                                                                                                                                                       |
| :---------------------- | :-------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Runtime & Provider**  | `UiProvider`, `createOverlayCoordinator`, `createNoticeBus`, `useOverlayPort`, `useOverlayLock`, `useUiNotice`, `useIsMobile`, `usePresence`, `copyText`, `computeAnchoredPosition`, `useAnchoredPosition`, `useDismiss`, `useDelayedOpen`, `VIEWPORT_PADDING`                                                                                |
| **Actions**             | `Button`, `LinkButton`, `IconButton`, `Chip`                                                                                                                                                                                                                                                                                                  |
| **Inputs & Selection**  | `TextField`, `PasswordField`, `Select`, `Switch`, `SegmentedControl`, `RadioCardGroup`                                                                                                                                                                                                                                                        |
| **Overlays & Floating** | `Dialog`, `Popover`, `MorphMenu` (with `morph.ts` geometry: `triggerShape`, `menuShape`, `contentClip`, `sampleMorph`, `spring`, `MORPH_OPEN`, `MORPH_CLOSE`, `MORPH_CLOSE_MS`), `Menu`, `Tooltip`, `HoverCard`, `ToastViewport`                                                                                                              |
| **Navigation & Motion** | `Tabs`, `TabList`, `Tab`, `TabPanel`, `HoverGlide`, `useHoverGlide`, `HoverGlideIndicator`, `hoverGlideItem`, `HOVER_GLIDE_ITEM_ATTR`, `HOVER_GLIDE_SURFACE_ATTR`, `INITIAL_HOVER_GLIDE_STATE`, `enterGlideTarget`, `leaveGlideTarget`, `expireGlideCooldown`, `syncGlideRect`, `measureGlideRect`, `normalizeGlideRadius`, `glideRectsEqual` |
| **Feedback & Layout**   | `Badge`, `Banner`, `EmptyState`, `Spinner`, `SettingGroup`, `SettingRow`, `SettingInlineConfirm`, `PanelHeader`                                                                                                                                                                                                                               |
| **Icons & Glyphs**      | Domain-blind `Icon*` SVG components and `FileGlyph` (`kind: 'document' \| 'pdf' \| 'spreadsheet' \| 'presentation' \| 'image'`)                                                                                                                                                                                                               |

## Behavioural & Accessibility Invariants

1. **Strict token consumption.** Every colour, border, shadow, radius, spacing step, z-index layer,
   typography style, and motion duration comes from semantic `--ui-*` tokens in
   `spine/design/tokens.css` (inside `@layer components`). Components never reference private
   `--_p-*` primitives, raw colour literals, or theme-attribute selectors (`[data-theme="dark"]`).
2. **WCAG 2.2 AA contrast & targets.** All semantic text/surface token pairs meet `>= 4.5:1`
   luminance contrast and UI/border/focus pairs meet `>= 3:1` in both light and dark themes.
   Interactive icon buttons and controls maintain `>= 24 × 24 CSS px` minimum hit targets on fine
   pointers and `>= 44 × 44 CSS px` on `@media (pointer: coarse)`.
3. **Focus visibility.** Every interactive control styles `:focus-visible` with a visible `outline`
   and `outline-offset` (plus Forced Colors Mode compatibility). Never suppress outlines without a
   replacement focus indicator.
4. **Native modal dialogs (`Dialog`).** Renders a native `<dialog>` element opened with
   `showModal()` without redundant `role="dialog"` or `aria-modal`. Exposes its heading as `<h1>`
   linked via `aria-labelledby`, acquires an `OverlayPort` lock while mounted, intercepts `cancel`
   (`Escape`) and outside-pointer clicks only when `dismissible` is true, and requires both
   `pointerdown` and `pointerup` outside the dialog bounding box so padding clicks or text-selection
   drags never dismiss it.
5. **Anchored overlays (`Popover`, `Menu`, `Select`, `Tooltip`, `HoverCard`).**
   - `computeAnchoredPosition` always returns coordinates clamped inside the viewport with at least
     `VIEWPORT_PADDING` clearance when the floating box fits within the viewport, and flips sides
     when the preferred side lacks space.
   - `Menu` and `Select` render native `<button type="button">` items (never `<div>` click targets),
     support `ArrowDown`/`ArrowUp`/`Home`/`End`/`Escape`, use `<hr>` for separators, and acquire an
     `OverlayPort` lock while open.
   - `Tooltip` satisfies WCAG 1.4.13: opens on both hover and focus, stays open while hovered, and
     dismisses on `Escape` without moving the pointer.
   - `MorphMenu` is a `Popover` that grows out of its trigger. It opens over the trigger with one
     corner shared (`side` `top` or `bottom`, `align` `start` or `end`); its background starts on
     the trigger's box and corner radius and unfolds to the menu, the content is clipped to the
     background, and the trigger's own contents fade out while open and back in on close. A run
     starts from the previous run's current shape, so reopening mid-close does not jump. Under
     `prefers-reduced-motion` the background appears at full size and only fades. Triggers must
     not scale on press, because placement uses the trigger's measured box.
6. **Form fields (`TextField`, `PasswordField`, `Switch`, `SegmentedControl`, `RadioCardGroup`).**
   - `TextField` and `PasswordField` programmatically associate visible `<label htmlFor>`, place
     hints above the input linked via `aria-describedby`, set `aria-invalid="true"` only when an
     error message is present, and never block paste or password managers (WCAG 3.3.8).
   - `Switch` renders a native `<button type="button" role="switch" aria-checked={checked}>`.
   - `SegmentedControl` renders a `role="group"` of native buttons with `aria-pressed`.
   - `RadioCardGroup` renders `role="radiogroup"` with native `<button role="radio" aria-checked>`.
   - `Tabs` renders `role="tablist"`, `<button role="tab" aria-selected>`, and `role="tabpanel"`
     with roving arrow-key navigation.
7. **Hermetic overlay & notice coordinators (zero global singletons).**
   - `createOverlayCoordinator()` emits `true` only on `0 -> 1` and `false` only on `1 -> 0`;
     calling a release function more than once is a no-op.
   - `createNoticeBus()` holds at most one active notice (new notices replace old ones and cancel
     stale timers), renders `text()` in the current locale at render time, and expires after its
     duration (longer when a link is present).
8. **Hover glide.** `<HoverGlide>` and `useHoverGlide` provide a single-surface gliding hover
   container that isolates its stacking context, elevates `[data-hover-glide-item]` targets above
   the indicator, and suppresses duplicate native `:hover` backgrounds on unmuted `Button` /
   `IconButton` items while active. `enterGlideTarget` snaps on cold entry and glides on warm
   transitions; `leaveGlideTarget` enters `cooling` so crossing small gaps keeps gliding until
   `expireGlideCooldown` resets cold; muted items track invisibly and update immediately on
   attribute change; disabled items are ignored; `measureGlideRect` round-trips cleanly between
   viewport and scroll-content coordinates; `normalizeGlideRadius` clamps per-item corner radii to
   half the smaller box dimension so mixed shapes (such as rounded rows and capsule pills) morph
   smoothly; ancestor scroll and layout resizes re-target the stationary pointer.
9. **Buttons & loading states.** `Button` defaults to `type="button"`, preserves label visibility
   and width under `loading` (`aria-busy="true"`), and never omits accessible text on `IconButton`.
10. **Presence lifecycle (`usePresence`).** Mounts synchronously (`mounted: true`, `exiting: false`)
    on the render where `open` becomes `true` without performing render-phase state updates (so
    sibling `useSyncExternalStore` hooks stay in sync across repeated cycles returning to prior
    snapshots). When `open` becomes `false`, stays `mounted: true, exiting: true` for `durationMs`
    before unmounting, cancels pending exit timers if reopened mid-exit, and unmounts immediately
    when `durationMs <= 0` or `(prefers-reduced-motion: reduce)` matches.

## Tunable Parameters

| Parameter                    | Default   | Meaning                                                                   |
| :--------------------------- | :-------- | :------------------------------------------------------------------------ |
| `VIEWPORT_PADDING`           | `8` px    | Minimum clearance between an anchored floating surface and viewport edges |
| Tooltip enter delay          | `100` ms  | Pointer hover delay before showing a tooltip                              |
| Popover exit duration        | `140` ms  | Fade/scale exit animation duration                                        |
| MorphMenu open               | `250` ms  | Height on a spring (~1.5% overshoot); width on a firmer one in `170` ms   |
| MorphMenu close              | `180` ms  | Height folds in `130` ms, width in `160` ms; exit duration `180` ms       |
| Dialog / Toast exit duration | `160` ms  | Fade/scale exit animation duration                                        |
| Notice default duration      | `3000` ms | Auto-dismiss timeout for plain notices                                    |
| Notice link duration         | `5000` ms | Auto-dismiss timeout for notices containing a link                        |
| Hover glide cooldown         | `120` ms  | Window to glide across inter-item gaps before snapping cold               |
