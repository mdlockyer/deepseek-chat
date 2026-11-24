# SPEC: `libs/stage` (Sealed Responsive Viewport Stage Library)

## Purpose

Domain-blind responsive viewport stage, preset/custom dimension selector, and aspect-fit math
shared by surfaces that preview or host fixed-viewport content (e.g., embedded web previews and
rendered HTML previews). Depends strictly on `@deepseek-chat/spine` and `@deepseek-chat/lib-ui`.

## Public Entrypoint (`@deepseek-chat/lib-stage`)

- **Components:** `StageFrame`, `ViewportMenu`
- **Pure Geometry & Parsing:** `fitViewportToStage`, `clampViewportWidth`, `clampViewportHeight`,
  `findMatchingViewportPreset`, `isCustomViewport`, `computeDraggedViewportSize`,
  `getDefaultCustomViewportSize`, `parseCustomViewportInput`, `parseAspectRatio`
- **Constants & Types:** `VIEWPORT_PRESETS`, `MIN_VIEWPORT_WIDTH`, `MAX_VIEWPORT_WIDTH`,
  `MIN_VIEWPORT_HEIGHT`, `MAX_VIEWPORT_HEIGHT`, `MIN_VIEWPORT_ZOOM`, `ViewportPreset`,
  `ViewportSpec`, `StageFit`, `ViewportDragEdge`, `CustomViewportParseResult`

## Behavioural Invariants

1. **Bounded stage fitting (`fitViewportToStage`).** For any positive `stageWidth` and
   `stageHeight` and any `ViewportSpec | null`:
   - `1 <= boxWidth <= Math.max(1, Math.floor(stageWidth))`
   - `1 <= boxHeight <= Math.max(1, Math.floor(stageHeight))`
   - `MIN_VIEWPORT_ZOOM <= zoom <= 1`
   - When `viewport === null`, `letterboxed === false`, `clipped === false`, `zoom === 1`,
     `scale === 1`.
   - When `viewport !== null`, `letterboxed === true`, and `clipped === true` iff the ideal scale
     is strictly below `MIN_VIEWPORT_ZOOM`.
2. **Symmetric drag clamping (`computeDraggedViewportSize`).** Dragging `right` modifies only
   width, `bottom` modifies only height, and `corner` modifies both, always clamping results to
   `[MIN_VIEWPORT_WIDTH, MAX_VIEWPORT_WIDTH]` × `[MIN_VIEWPORT_HEIGHT, MAX_VIEWPORT_HEIGHT]`.
3. **Strict custom input validation (`parseCustomViewportInput`).** Accepts integer or decimal pixel
   strings (optional `px` suffix) only within bounds, reporting independent `widthInvalid` and
   `heightInvalid` flags on rejection.
4. **UI & token discipline.** `ViewportMenu` builds on `@deepseek-chat/lib-ui` (`Popover`,
   `Button`, `IconButton`, `Tooltip`), automatically acquires an `OverlayPort` lock while open, and
   uses strictly semantic `--ui-*` tokens inside `@layer components`.

## Tunable Parameters

| Parameter                                     | Default                                                                        | Meaning                            |
| :-------------------------------------------- | :----------------------------------------------------------------------------- | :--------------------------------- |
| `MIN_VIEWPORT_WIDTH` / `MAX_VIEWPORT_WIDTH`   | `320` / `2560` px                                                              | Clamped width bounds               |
| `MIN_VIEWPORT_HEIGHT` / `MAX_VIEWPORT_HEIGHT` | `240` / `2560` px                                                              | Clamped height bounds              |
| `MIN_VIEWPORT_ZOOM`                           | `0.25`                                                                         | Minimum zoom floor before clipping |
| `VIEWPORT_PRESETS`                            | mobile `390×844`, tablet `768×1024`, desktop `1280×720`, widescreen `1440×900` | Built-in preset dimensions         |
