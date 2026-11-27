# SPEC: `libs/ui` (Sealed Domain-Blind Component Kit)

## Purpose

Zero-dependency, domain-blind React component kit implementing the semantic token system in
`spine/design/tokens.css`. Every slice, UI library, and the App Shell consumes `@deepseek-chat/lib-ui`
through its single `.` export. Zero domain nouns, zero slice imports, and zero global mutable UI
singletons; designed for clean-slate regeneration from this `SPEC.md`, `spine/`, and `libs/ui/tests/`.

## Public Entrypoint (`@deepseek-chat/lib-ui`)

| Category                | Exports                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                          |
| :---------------------- | :------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Runtime & Provider**  | `UiProvider`, `createOverlayCoordinator`, `createNoticeBus`, `useOverlayPort`, `useOverlayLock`, `useUiNotice`, `useIsMobile`, `usePresence`, `copyText`, `computeAnchoredPosition`, `useAnchoredPosition`, `useDismiss`, `useDelayedOpen`, `VIEWPORT_PADDING`                                                                                                                                                                                                                                                                                                                                                                                                                   |
| **Actions**             | `Button`, `LinkButton`, `IconButton`, `Chip`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                     |
| **Inputs & Selection**  | `TextField`, `PasswordField`, `Select`, `Switch`, `SegmentedControl`, `RadioCardGroup`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                           |
| **Overlays & Floating** | `Dialog`, `Popover`, `MorphMenu` (and morph geometry helpers `triggerShape`, `menuShape`, `contentClip`, `sampleMorph`, `spring`, `MORPH_*`), `Menu`, `PanelTitleMenu`, `Tooltip`, `HoverCard`, `ToastViewport`                                                                                                                                                                                                                                                                                                                                                                                                                                                                  |
| **Navigation & Motion** | `Minimap` (and layout helpers `layoutMinimapMap`, `stepMinimapFocus`, `shapeMinimapSection`, `minimapLineDetail`, `minimapBlockDetail`, `mixRect`, `MINIMAP_*`), `readingLineY`, `sectionAt`, `measureSectionTops`, `sectionAtReadingLine`, `createReaderScroll`, `createScrollGlide` (`stepScrollSpring`, `scrollSpringSettled`, `SCROLL_GLIDE_*`), `onScrollIntent`, `Tabs`, `TabList`, `Tab`, `TabPanel`, `HoverGlide`, `useHoverGlide`, `HoverGlideIndicator`, `hoverGlideItem`, `HOVER_GLIDE_*`, `INITIAL_HOVER_GLIDE_STATE`, `enterGlideTarget`, `leaveGlideTarget`, `expireGlideCooldown`, `syncGlideRect`, `measureGlideRect`, `normalizeGlideRadius`, `glideRectsEqual` |
| **Feedback & Layout**   | `Badge`, `Banner`, `EmptyState`, `Spinner`, `SettingGroup`, `SettingRow`, `SettingInlineConfirm`, `PanelHeader`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                  |
| **Icons & Glyphs**      | Domain-blind `Icon*` SVG components and `FileGlyph` (`document \| pdf \| spreadsheet \| presentation \| image`)                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                  |

## Behavioural & Accessibility Invariants

1. **Strict token consumption.** All colours, borders, shadows, radii, spacing, z-index, typography,
   and motion come from semantic `--ui-*` tokens inside `@layer components` — never private `--_p-*`
   primitives, raw colour literals, or `[data-theme="dark"]` selectors.
2. **WCAG 2.2 AA contrast & targets.** Text/surface token pairs meet `>= 4.5:1` and UI/border/focus
   pairs meet `>= 3:1` in light and dark themes. Interactive targets maintain `>= 24 × 24 CSS px`
   (fine pointer) and `>= 44 × 44 CSS px` (`pointer: coarse`).
3. **Focus visibility.** Every interactive control styles `:focus-visible` with visible `outline` +
   `outline-offset` (Forced Colors Mode compatible); outlines are never stripped without replacement.
4. **Native modal dialogs (`Dialog`).** Native `<dialog>` opened via `showModal()` (no redundant
   `role="dialog"` / `aria-modal`), `<h1>` linked via `aria-labelledby`, acquires `OverlayPort`
   while mounted, dismisses on `Escape` or outside click only when `dismissible`, and requires both
   `pointerdown` and `pointerup` outside the box so selection drags never dismiss.
5. **Anchored overlays (`Popover`, `Menu`, `Select`, `Tooltip`, `HoverCard`, `MorphMenu`, `PanelTitleMenu`).**
   - `computeAnchoredPosition` clamps inside the viewport with `VIEWPORT_PADDING` clearance and flips
     sides when preferred space is insufficient.
   - `Menu`/`Select` use native `<button type="button">` items, `ArrowUp`/`ArrowDown`/`Home`/`End`/
     `Escape`, `<hr>` separators, and `OverlayPort` locks.
   - `Tooltip` satisfies WCAG 1.4.13 (hover + focus, hoverable content, `Escape` dismissal).
   - `MorphMenu` unfolds from a shared corner of its trigger box/radius with clipped content, fades
     trigger contents while open, continues seamlessly from in-flight close shapes, fades at full
     size under reduced motion, and requires triggers not to scale on press.
   - `PanelTitleMenu` renders a chevron `Menu` for `>= 2` options and identical-box plain text for
     `< 2` options so headers never shift.
6. **Form controls.** `TextField`/`PasswordField` link visible `<label htmlFor>` and above-input
   hints (`aria-describedby`), set `aria-invalid="true"` only on error, and never block paste or
   password managers (WCAG 3.3.8). `Switch` (`role="switch"`), `SegmentedControl` (`aria-pressed`),
   `RadioCardGroup` (`role="radiogroup"`), and `Tabs` (`tablist`/roving arrows) use native buttons.
7. **Hermetic coordinators.** `createOverlayCoordinator()` emits `true` only on `0 -> 1` and `false`
   only on `1 -> 0` with idempotent release; `createNoticeBus()` holds at most one active notice,
   translates lazily in the current locale, cancels stale timers, and extends duration for links.
8. **Hover glide.** Isolates stacking context, elevates `[data-hover-glide-item]` above the
   indicator, suppresses duplicate `:hover` backgrounds while active, snaps cold / glides warm,
   holds `cooling` across small gaps, tracks muted items invisibly, ignores disabled items, clamps
   radii via `normalizeGlideRadius`, and re-targets on ancestor scroll/resize.
9. **Buttons & presence (`usePresence`).** `Button` defaults to `type="button"`, keeps label width
   during `loading` (`aria-busy="true"`), and `IconButton` always carries accessible text.
   `usePresence` mounts synchronously without render-phase state updates, holds `exiting: true` for
   `durationMs` on close, cancels exit timers on reopen, and unmounts immediately when
   `durationMs <= 0` or reduced motion matches.
10. **Minimap (`Minimap`).** Draws a theme-aware `aria-hidden` canvas of `[sectionSelector]`
    children with `[markerSelector]` highlights, clipped-container culling, per-section incremental
    remeasurement, progressive LOD (lines → blocks → slabs, never mixing lines and slabs), a
    spring-following focus lens that keeps the window sized and fills the rail exactly, dashed
    `dividerBefore` rules, and a surface veil outside the viewport window. Clicks emit
    `onSeek(top, 'glide')`; window drags emit `onSeek(top, 'drag')` + `onDragEnd`. A sibling
    `<nav aria-label>` exposes roving-tabindex native buttons (`aria-current="location"`,
    `ArrowUp`/`ArrowDown`/`Home`/`End`/`Enter`). Keeps clear of scrollbars, hides below its gutter
    threshold via `onShownChange`, and jumps in place under reduced motion.
11. **Reading line & scroll glide.** `readingLineY` moves monotonically top → middle → bottom across
    scroll progress so every section is current somewhere (non-scrolling content reads at end).
    `createReaderScroll` distinguishes reader scrolling (drag or within `READER_SCROLL_WINDOW_MS` of
    input/prior reader scroll) from programmatic glides. `createScrollGlide` drives `scrollTop` via
    critically damped spring (zero overshoot, clamped, retargetable without velocity reset, fires
    `onDone` only on landing, jumps under reduced motion).

## Tunable Parameters

| Parameter                                   | Default                               | Meaning                                                        |
| :------------------------------------------ | :------------------------------------ | :------------------------------------------------------------- |
| `VIEWPORT_PADDING`                          | `8` px                                | Minimum clearance between floating overlays and viewport edges |
| Tooltip / Popover / Dialog-Toast            | `100` / `140` / `160` ms              | Hover delay and exit durations                                 |
| `MorphMenu` open / close                    | `250` / `180` ms                      | Spring open (~1.5% overshoot, width `170 ms`) and fold close   |
| Notice plain / link duration                | `3000` / `5000` ms                    | Auto-dismiss timeouts                                          |
| Hover glide cooldown                        | `120` ms                              | Cooling window across inter-item gaps                          |
| Minimap full scale / lens                   | `0.1` / `1` & `3` vp (cap `0.6` rail) | Text-line scale threshold and focus-lens span                  |
| Minimap lens follow / highlight             | `0.5` vp / `90` / `120` ms            | Deadband, spring stiffness, highlight easing                   |
| Minimap window / veil / gutter              | `16` px / `0.35`–`0.5` / `48` px      | Min window height, veil strength, hide width                   |
| `READER_SCROLL_WINDOW_MS` / glide stiffness | `250` ms / `210` /s²                  | Reader-input attribution window and critically damped glide    |
