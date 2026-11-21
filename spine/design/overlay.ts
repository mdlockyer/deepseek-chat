/**
 * Whether any HTML overlay (menu, modal, popover) is open. Native surfaces drawn above the page
 * (such as an embedded webview) cannot be layered under HTML, so their owner listens here and
 * steps aside while an overlay is open.
 */

let openCount = 0
const listeners = new Set<(open: boolean) => void>()

const notify = (open: boolean) => {
  for (const listener of [...listeners]) {
    listener(open)
  }
}

/** Marks an overlay as open. Call the returned function once to release it; extra calls are ignored. */
export const acquireOverlay = (): (() => void) => {
  openCount += 1
  if (openCount === 1) {
    notify(true)
  }
  let released = false
  return () => {
    if (released) {
      return
    }
    released = true
    openCount -= 1
    if (openCount === 0) {
      notify(false)
    }
  }
}

export const isOverlayOpen = () => openCount > 0

/** Called with `true` when the first overlay opens and `false` when the last one closes. */
export const onOverlayChange = (listener: (open: boolean) => void): (() => void) => {
  listeners.add(listener)
  return () => {
    listeners.delete(listener)
  }
}
