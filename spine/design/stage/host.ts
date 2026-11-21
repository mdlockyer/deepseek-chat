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
