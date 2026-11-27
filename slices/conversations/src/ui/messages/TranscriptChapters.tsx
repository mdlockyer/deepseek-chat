import {
  Minimap,
  createScrollGlide,
  onScrollIntent,
  readingLineY,
  sectionAt,
  type MinimapSection,
  type ScrollGlide,
} from '@deepseek-chat/lib-ui'
import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type RefObject,
} from 'react'
import { useConversations } from '../../context.js'
import { useTranslate } from '../../messages.js'
import type { ReadingCause } from '../../reading.js'
import { excerptOfPrompt } from '../../turns.js'
import type { CompactionCheckpoint, Message } from '../../types.js'
import { useScrollFollow } from './scrollContext.js'
import styles from './TranscriptChapters.module.css'

/** One turn of the visible branch: a prompt and its reply, keyed by the reply's message id. */
export type TranscriptTurn = {
  readonly messageId: string
  readonly label: string
  /** A compaction checkpoint sits between this turn and the one before it. */
  readonly afterCheckpoint: boolean
}

/** Space left above a turn's first message after jumping to it. */
const LANDING_MARGIN_PX = 24
/** How long scrolling must rest on a turn before followers are told. */
const FOLLOW_DELAY_MS = 100
/** Jumps longer than this many viewports offer a way back. */
const RETURN_THRESHOLD = 1.2

/** Turns of the visible branch in order; a reply's label is the prompt before it. */
export const buildTranscriptTurns = (
  messages: readonly Message[],
  checkpoints: readonly CompactionCheckpoint[]
): TranscriptTurn[] => {
  const checkpointAnchors = new Set(checkpoints.map((checkpoint) => checkpoint.anchorMessageId))
  const turns: TranscriptTurn[] = []
  let label = ''
  let pendingCheckpoint = false
  messages.forEach((message) => {
    if (message.role === 'user') {
      label = excerptOfPrompt(message.content)
    } else {
      turns.push({
        messageId: message.id,
        label,
        afterCheckpoint: pendingCheckpoint && turns.length > 0,
      })
      pendingCheckpoint = false
    }
    if (checkpointAnchors.has(message.id)) {
      pendingCheckpoint = true
    }
  })
  return turns
}

/** The message that starts each turn on screen (its prompt, or the reply when it has none). */
export const turnStartIds = (messages: readonly Message[]): ReadonlyMap<string, string> => {
  const starts = new Map<string, string>()
  messages.forEach((message, index) => {
    if (message.role !== 'assistant') {
      return
    }
    const previous = messages[index - 1]
    starts.set(previous?.role === 'user' ? previous.id : message.id, message.id)
  })
  return starts
}

const isEditable = (target: EventTarget | null) =>
  target instanceof HTMLElement &&
  (target.isContentEditable || Boolean(target.closest('input, textarea, select')))

/**
 * The transcript's minimap and everything that ties it to scrolling: which turn is being read,
 * clicking and dragging on the map, returning to where the reader was, ⌥↑ / ⌥↓ / ⌥←, and reveals
 * requested by the Activity panel. Reports the reading turn to `reading` so sibling views can
 * follow; never scrolls on its own except when asked.
 */
export const TranscriptChapters = ({
  sessionId,
  turns,
  scrollRef,
  contentRef,
}: {
  sessionId: string
  turns: readonly TranscriptTurn[]
  scrollRef: RefObject<HTMLDivElement | null>
  contentRef: RefObject<HTMLDivElement | null>
}) => {
  const t = useTranslate()
  const { reading } = useConversations()
  const follow = useScrollFollow()
  const glideRef = useRef<ScrollGlide | null>(null)
  const topsRef = useRef<number[]>([])
  const lockRef = useRef<number | null>(null)
  const publishTimer = useRef(0)
  const turnsRef = useRef(turns)
  turnsRef.current = turns
  const [current, setCurrent] = useState(Math.max(0, turns.length - 1))
  const currentRef = useRef(current)
  /** The turn ⌥← goes back to after a long jump, until the reader is there again. */
  const returnRef = useRef<number | null>(null)

  const measure = useCallback(() => {
    const scroll = scrollRef.current
    const content = contentRef.current
    if (!scroll || !content) {
      return
    }
    const base = scroll.getBoundingClientRect().top - scroll.scrollTop
    const starts = new Map<string, number>()
    for (const anchor of content.querySelectorAll<HTMLElement>('[data-turn-anchor]')) {
      const id = anchor.dataset.turnAnchor
      if (id) {
        starts.set(id, anchor.getBoundingClientRect().top - base)
      }
    }
    topsRef.current = turnsRef.current.map((turn) => starts.get(turn.messageId) ?? 0)
  }, [scrollRef, contentRef])

  const indexAt = (y: number) => sectionAt(topsRef.current, y)

  const publish = useCallback(
    (index: number, cause: ReadingCause, immediate: boolean) => {
      const turn = turnsRef.current[index]
      window.clearTimeout(publishTimer.current)
      if (!turn) {
        return
      }
      const write = () => reading.setReadingPosition(sessionId, turn.messageId, cause)
      if (immediate) {
        write()
      } else {
        publishTimer.current = window.setTimeout(write, FOLLOW_DELAY_MS)
      }
    },
    [reading, sessionId]
  )

  const setCurrentIndex = (index: number) => {
    if (currentRef.current !== index) {
      currentRef.current = index
      setCurrent(index)
    }
  }

  const paint = () => {
    const scroll = scrollRef.current
    if (!scroll) {
      return
    }
    if (lockRef.current !== null) {
      return
    }
    const index = indexAt(readingLineY(scroll.scrollTop, scroll.clientHeight, scroll.scrollHeight))
    if (index !== currentRef.current) {
      setCurrentIndex(index)
      publish(index, 'reader', false)
    }
    if (returnRef.current === index) {
      returnRef.current = null
    }
  }
  const paintRef = useRef(paint)
  paintRef.current = paint

  // Scroll frames update the reading turn; the reader's own input releases a navigation lock.
  useEffect(() => {
    const scroll = scrollRef.current
    const content = contentRef.current
    if (!scroll || !content) {
      return
    }
    const glide = createScrollGlide(scroll)
    glideRef.current = glide
    let frame = 0
    const onScroll = () => {
      frame ||= requestAnimationFrame(() => {
        frame = 0
        paintRef.current()
      })
    }
    const observer = new ResizeObserver(() => {
      measure()
      paintRef.current()
    })
    observer.observe(content)
    observer.observe(scroll)
    scroll.addEventListener('scroll', onScroll, { passive: true })
    const stopIntent = onScrollIntent(scroll, () => {
      lockRef.current = null
      glide.cancel()
    })
    return () => {
      cancelAnimationFrame(frame)
      observer.disconnect()
      scroll.removeEventListener('scroll', onScroll)
      stopIntent()
      glide.cancel()
      glideRef.current = null
      window.clearTimeout(publishTimer.current)
    }
  }, [scrollRef, contentRef, measure])

  // A different chat starts fresh: no lock, nowhere to return to.
  useLayoutEffect(() => {
    lockRef.current = null
    returnRef.current = null
  }, [sessionId])

  const turnKey = turns.map((turn) => turn.messageId).join(' ')
  // Turns added, removed or switched: measure after the list has settled its own scroll position
  // (its layout effects run after ours), then report where the reader is.
  useEffect(() => {
    if (lockRef.current !== null && lockRef.current >= turns.length) {
      lockRef.current = null
    }
    const frame = requestAnimationFrame(() => {
      measure()
      paintRef.current()
      publish(currentRef.current, lockRef.current === null ? 'reader' : 'reveal', true)
    })
    return () => cancelAnimationFrame(frame)
  }, [turnKey, turns.length, measure, publish])

  const land = useCallback(
    (messageId: string) => {
      const anchor = contentRef.current?.querySelector<HTMLElement>(
        `[data-turn-anchor="${CSS.escape(messageId)}"]`
      )
      const bubble = anchor?.nextElementSibling?.querySelector<HTMLElement>('[data-turn-bubble]')
      if (!bubble) {
        return
      }
      bubble.removeAttribute('data-landing')
      void bubble.offsetWidth
      bubble.setAttribute('data-landing', '')
    },
    [contentRef]
  )

  const navigate = useCallback(
    (
      index: number,
      { instant = false, offerReturn = true, cause = 'reader' as ReadingCause, landing = true } = {}
    ) => {
      const scroll = scrollRef.current
      const turn = turnsRef.current[index]
      if (!scroll || !turn) {
        return
      }
      measure()
      const from = currentRef.current
      const target = Math.max(0, (topsRef.current[index] ?? 0) - LANDING_MARGIN_PX)
      if (
        offerReturn &&
        index !== from &&
        Math.abs(target - scroll.scrollTop) > scroll.clientHeight * RETURN_THRESHOLD
      ) {
        returnRef.current = from
      }
      follow.stop()
      lockRef.current = index
      setCurrentIndex(index)
      publish(index, cause, true)
      glideRef.current?.to(target, {
        instant,
        ...(landing ? { onDone: () => land(turn.messageId) } : {}),
      })
    },
    [scrollRef, measure, follow, publish, land]
  )

  const goLatest = useCallback(
    (cause: ReadingCause) => {
      const scroll = scrollRef.current
      if (!scroll) {
        return
      }
      lockRef.current = null
      returnRef.current = null
      publish(turnsRef.current.length - 1, cause, true)
      glideRef.current?.to(scroll.scrollHeight, { onDone: () => follow.sync() })
    },
    [scrollRef, publish, follow]
  )

  const returnBack = useCallback(() => {
    const target = returnRef.current
    if (target === null) {
      return
    }
    returnRef.current = null
    navigate(target, { offerReturn: false })
  }, [navigate])

  // Reveals from the Activity panel (or anything else holding the reveal port).
  const reveal = reading.useReadingStore((state) => state.reveal)
  const handledNonce = useRef(reveal?.nonce ?? 0)
  useEffect(() => {
    if (!reveal || reveal.nonce === handledNonce.current) {
      return
    }
    handledNonce.current = reveal.nonce
    if (reveal.sessionId !== sessionId) {
      return
    }
    const { messageId } = reveal
    const index = turnsRef.current.findIndex((turn) => turn.messageId === messageId)
    if (index >= 0) {
      navigate(index, { offerReturn: false, cause: 'reveal' })
    }
  }, [reveal, sessionId, navigate])

  // ⌥↑ / ⌥↓ step between turns (⌥↑ first returns to the top of the current one); ⌥← goes back.
  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (
        !event.altKey ||
        event.metaKey ||
        event.ctrlKey ||
        event.shiftKey ||
        event.defaultPrevented ||
        isEditable(event.target)
      ) {
        return
      }
      const scroll = scrollRef.current
      const index = currentRef.current
      if (event.key === 'ArrowUp' && scroll) {
        event.preventDefault()
        const top = (topsRef.current[index] ?? 0) - LANDING_MARGIN_PX
        navigate(scroll.scrollTop > top + 8 ? index : Math.max(0, index - 1))
      } else if (event.key === 'ArrowDown') {
        event.preventDefault()
        if (index >= turnsRef.current.length - 1) {
          goLatest('reader')
        } else {
          navigate(index + 1)
        }
      } else if (event.key === 'ArrowLeft' && returnRef.current !== null) {
        event.preventDefault()
        returnBack()
      }
    }
    window.addEventListener('keydown', onKeyDown)
    return () => window.removeEventListener('keydown', onKeyDown)
  }, [scrollRef, navigate, goLatest, returnBack])

  // A click on the map glides there (offering a way back from far away); dragging the window
  // scrolls directly, and offers the way back once it's let go.
  const seek = useCallback(
    (top: number, how: 'glide' | 'drag') => {
      const scroll = scrollRef.current
      if (!scroll) {
        return
      }
      lockRef.current = null
      follow.stop()
      if (how === 'drag') {
        glideRef.current?.cancel()
        scroll.scrollTop = top
        return
      }
      if (Math.abs(top - scroll.scrollTop) > scroll.clientHeight * RETURN_THRESHOLD) {
        returnRef.current = currentRef.current
      }
      glideRef.current?.to(top)
    },
    [scrollRef, follow]
  )

  const dragEnded = useCallback(
    (fromTop: number) => {
      const scroll = scrollRef.current
      if (
        !scroll ||
        Math.abs(scroll.scrollTop - fromTop) <= scroll.clientHeight * RETURN_THRESHOLD
      ) {
        return
      }
      const line = readingLineY(fromTop, scroll.clientHeight, scroll.scrollHeight)
      const from = sectionAt(topsRef.current, line)
      if (from !== currentRef.current) {
        returnRef.current = from
      }
    },
    [scrollRef]
  )

  // While the minimap is on screen it shows where the reader is, so the scrollbar hides.
  const markScroller = useCallback(
    (shown: boolean) => scrollRef.current?.toggleAttribute('data-minimap', shown),
    [scrollRef]
  )

  const sections = useMemo(
    (): MinimapSection[] =>
      turns.map((turn, index) => {
        const label = turn.label || t('chapterContinued')
        return {
          key: turn.messageId,
          accessibleLabel: t('chapterLabel', { number: index + 1, prompt: label }),
          ...(turn.afterCheckpoint ? { dividerBefore: true } : {}),
        }
      }),
    [turns, t]
  )

  return (
    <div className={styles.gutter}>
      <Minimap
        className={styles.rail}
        sections={sections}
        current={Math.min(current, Math.max(0, turns.length - 1))}
        ariaLabel={t('chapterRailLabel')}
        scrollRef={scrollRef}
        contentRef={contentRef}
        sectionSelector="[data-turn-anchor]"
        markerSelector="[data-turn-bubble]"
        side="right"
        onShownChange={markScroller}
        onSeek={seek}
        onDragEnd={dragEnded}
        onNavigate={(index) => navigate(index)}
      />
    </div>
  )
}
