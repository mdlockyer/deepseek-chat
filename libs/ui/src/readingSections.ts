import { readingLineY, sectionAt } from './readingLine.js'
import { onScrollIntent } from './scrollGlide.js'

/**
 * Where each section starts in a scroll container's content, in px from the top of that content,
 * given the elements that start the sections (in document order).
 */
export const measureSectionTops = (
  scroll: HTMLElement,
  starts: Iterable<HTMLElement>
): number[] => {
  const base = scroll.getBoundingClientRect().top - scroll.scrollTop
  return Array.from(starts, (start) => start.getBoundingClientRect().top - base)
}

/** The index of the section under a scroll container's reading line (see `readingLineY`). */
export const sectionAtReadingLine = (scroll: HTMLElement, tops: readonly number[]): number =>
  sectionAt(tops, readingLineY(scroll.scrollTop, scroll.clientHeight, scroll.scrollHeight))

/** Scroll events this soon after the reader's own input (or another such event) are theirs. */
export const READER_SCROLL_WINDOW_MS = 250

export type ReaderScroll = {
  /**
   * Whether the scroll happening now is the reader's: they are dragging (the scrollbar or the
   * content), or it comes within `READER_SCROLL_WINDOW_MS` of their wheel, touch, pointer or key
   * input or of the previous such scroll. Call it from the scroll handler; a `true` extends the
   * window, so momentum scrolling stays theirs.
   */
  readonly isReader: () => boolean
  readonly dispose: () => void
}

/**
 * Tells the reader's own scrolling of `el` apart from programmatic scrolling (glides, scroll
 * restoration, content growth). `onIntent` runs as the reader starts to scroll, for example to
 * cancel a glide.
 */
export const createReaderScroll = (
  el: HTMLElement,
  { onIntent }: { readonly onIntent?: () => void } = {}
): ReaderScroll => {
  let until = 0
  let dragging = false
  const stopIntent = onScrollIntent(el, () => {
    until = performance.now() + READER_SCROLL_WINDOW_MS
    onIntent?.()
  })
  const onPointerDown = () => {
    dragging = true
  }
  const onPointerUp = () => {
    dragging = false
  }
  el.addEventListener('pointerdown', onPointerDown)
  window.addEventListener('pointerup', onPointerUp)
  window.addEventListener('pointercancel', onPointerUp)
  return {
    isReader: () => {
      const now = performance.now()
      if (!dragging && now > until) {
        return false
      }
      until = now + READER_SCROLL_WINDOW_MS
      return true
    },
    dispose: () => {
      stopIntent()
      el.removeEventListener('pointerdown', onPointerDown)
      window.removeEventListener('pointerup', onPointerUp)
      window.removeEventListener('pointercancel', onPointerUp)
    },
  }
}
