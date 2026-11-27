import {
  createReaderScroll,
  createScrollGlide,
  measureSectionTops,
  sectionAtReadingLine,
  type ScrollGlide,
} from '@deepseek-chat/lib-ui'
import { useCallback, useEffect, useLayoutEffect, useRef, useState, type RefObject } from 'react'

/** Within this distance of the bottom, a live turn's new steps keep the panel at the bottom. */
const LIVE_STICK_PX = 48
/** Height of a sticky chapter header; a step brought into view clears it. */
const CHAPTER_HEADER_PX = 44

/** `value` made safe inside a CSS attribute selector's quotes. */
export const escapeAttr = (value: string) =>
  typeof CSS !== 'undefined' && typeof CSS.escape === 'function'
    ? CSS.escape(value)
    : value.replace(/["\\]/g, '\\$&')

/** The chapter (`data-chapter-id`) under a scroll container's reading line. */
const chapterAtLine = (el: HTMLElement): string | null => {
  const chapters = [...el.querySelectorAll<HTMLElement>('[data-chapter-id]')]
  if (chapters.length === 0) {
    return null
  }
  const index = sectionAtReadingLine(el, measureSectionTops(el, chapters))
  return chapters[index]?.dataset.chapterId ?? null
}

const isAtBottom = (el: HTMLElement) =>
  el.scrollHeight - el.scrollTop - el.clientHeight <= LIVE_STICK_PX

/**
 * Keeps one tab's scroll container in step with the panel. The container moves on its own only when
 * it is first shown (instantly, to `targetId`) and when `request` changes to a new pin (gliding to
 * `targetId`). The reader moving through the transcript never scrolls it: the container stays where
 * the reader left it, and its highlight names the turn under its own reading line, reported
 * through `onLineChapter`. A live last turn keeps the container at the bottom while its steps
 * arrive, as long as the reader is there.
 */
export const useChapterScroller = ({
  containerRef,
  targetId,
  request,
  lastId,
  live,
  visible,
  onLineChapter,
}: {
  containerRef: RefObject<HTMLDivElement | null>
  targetId: string | null
  /** Changes each time the reader asks for a turn (a pin); `null` while following. */
  request: object | null
  lastId: string | null
  live: boolean
  visible: boolean
  /**
   * The chapter under the container's reading line: when the tab is first shown, as the reader
   * scrolls it, and when it lands at the bottom.
   */
  onLineChapter: (messageId: string) => void
}) => {
  const glideRef = useRef<ScrollGlide | null>(null)
  const atBottomRef = useRef(true)
  const [atBottom, setAtBottom] = useState(true)
  const positionedRef = useRef(false)
  const requestRef = useRef<object | null>(null)
  const onLineRef = useRef(onLineChapter)
  onLineRef.current = onLineChapter
  const lastReportedRef = useRef<string | null>(null)
  const liveRef = useRef(live)
  liveRef.current = live
  const goalBottomRef = useRef(false)
  goalBottomRef.current = live && targetId !== null && targetId === lastId

  const glideFor = (el: HTMLDivElement) => (glideRef.current ??= createScrollGlide(el))
  const report = (el: HTMLElement) => {
    const id = chapterAtLine(el)
    if (id) {
      lastReportedRef.current = id
      onLineRef.current(id)
    }
  }
  const noteBottom = (el: HTMLElement) => {
    atBottomRef.current = isAtBottom(el)
    setAtBottom(atBottomRef.current)
  }

  useEffect(() => {
    const el = containerRef.current
    if (!el) {
      return
    }
    const glide = glideFor(el)
    const reader = createReaderScroll(el, { onIntent: () => glide.cancel() })
    const onScroll = () => {
      noteBottom(el)
      if (glide.isActive() || !reader.isReader()) {
        return
      }
      const id = chapterAtLine(el)
      if (id && id !== lastReportedRef.current) {
        lastReportedRef.current = id
        onLineRef.current(id)
      }
    }
    const observer = new ResizeObserver(() => {
      if (liveRef.current && atBottomRef.current && !glide.isActive()) {
        el.scrollTop = el.scrollHeight
        report(el)
      }
      noteBottom(el)
    })
    if (el.firstElementChild) {
      observer.observe(el.firstElementChild)
    }
    observer.observe(el)
    el.addEventListener('scroll', onScroll, { passive: true })
    return () => {
      reader.dispose()
      observer.disconnect()
      el.removeEventListener('scroll', onScroll)
      glide.cancel()
    }
  }, [containerRef])

  useLayoutEffect(() => {
    const el = containerRef.current
    if (!visible) {
      positionedRef.current = false
      return
    }
    if (!el || !targetId) {
      return
    }
    const first = !positionedRef.current
    if (!first && (request === null || request === requestRef.current)) {
      // The reader moved in the transcript, or let go of a pin: the container stays put.
      requestRef.current = request
      return
    }
    const chapter = el.querySelector<HTMLElement>(`[data-chapter-id="${escapeAttr(targetId)}"]`)
    if (!chapter) {
      return
    }
    requestRef.current = request
    lastReportedRef.current = targetId
    const goal = goalBottomRef.current ? el.scrollHeight : chapter.offsetTop
    if (first) {
      glideFor(el).to(goal, { instant: true })
      positionedRef.current = true
      report(el)
    } else {
      glideFor(el).to(goal)
    }
    noteBottom(el)
  }, [visible, targetId, request, containerRef])

  /** Glides just far enough to show `node` below the sticky chapter header. */
  const reveal = useCallback(
    (node: HTMLElement) => {
      const el = containerRef.current
      if (!el) {
        return
      }
      const top = node.getBoundingClientRect().top - el.getBoundingClientRect().top + el.scrollTop
      const bottom = top + node.offsetHeight
      if (top >= el.scrollTop + CHAPTER_HEADER_PX && bottom <= el.scrollTop + el.clientHeight) {
        return
      }
      glideFor(el).to(top - CHAPTER_HEADER_PX - 8)
    },
    [containerRef]
  )

  /** Glides to the bottom of the container, then names the turn there. */
  const toBottom = useCallback(() => {
    const el = containerRef.current
    if (!el) {
      return
    }
    glideFor(el).to(el.scrollHeight, { onDone: () => report(el) })
  }, [containerRef])

  return { reveal, toBottom, atBottom }
}
