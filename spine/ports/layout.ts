/**
 * Domain-blind layout slot ports owned by Tier 1 (The Spine).
 * Slices that render into a shared host panel receive a `PanelSlot` bound to their own kind.
 */

/** The measured area a stage can use, in CSS pixels. */
export type StageSize = { readonly width: number; readonly height: number }

/**
 * What a stage needs from the panel that hosts it: the shared stage size (one panel shows one
 * stage at a time) and the panel-wide "resizing" flag that native surfaces hide during.
 */
export type StageHost = {
  useStageSize(): StageSize | null
  setStageSize(size: StageSize): void
  setResizing(resizing: boolean): void
  isResizing(): boolean
}

/** The app's right-hand panel as one slice's slot in it (bound to that slice's panel kind). */
export type PanelLayout = {
  readonly activeSessionId: string | null
  /** Opening/closing animation in progress. */
  readonly animating: boolean
  /** The panel or a stage inside it is being resized. */
  readonly resizing: boolean
  /** An HTML overlay (menu, dialog) is open over the page. */
  readonly overlayLocked: boolean
  /** Panel width in CSS pixels. */
  readonly width: number
}

export type PanelSlot = StageHost & {
  /** Whether this slot is the panel shown for the session. */
  isOpen(sessionId: string | null): boolean
  open(sessionId: string): void
  close(sessionId: string): void
  setAnimating(animating: boolean): void
  getLayout(): PanelLayout
  /** Called after any layout or open-state change. */
  subscribe(listener: () => void): () => void
  /** React: a value derived from the layout (selectors should return primitives). */
  useLayout<T>(select: (layout: PanelLayout) => T): T
}
