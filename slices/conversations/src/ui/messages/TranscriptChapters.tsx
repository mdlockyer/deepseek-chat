import {
  ChapterRail,
  IconActivityOutline16,
  Tooltip,
  createScrollGlide,
  onScrollIntent,
  type ChapterRailHandle,
  type ChapterRailItem,
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
import { countToolCalls, excerptOfPrompt, hasTurnActivity } from '../../turns.js'
import type { CompactionCheckpoint, Message } from '../../types.js'
import { useScrollFollow } from './scrollContext.js'
import styles from './TranscriptChapters.module.css'

/** One turn of the visible branch: a prompt and its reply, keyed by the reply's message id. */
export type TranscriptTurn = {
  readonly messageId: string
  readonly label: string
  readonly live: boolean
  readonly activity: boolean
  readonly toolCalls: number
  /** A compaction checkpoint sits between this turn and the one before it. */
  readonly afterCheckpoint: boolean
}

/** Fraction of the viewport, from the top, where reading happens: the turn crossing it is current. */
const READING_LINE = 0.3
/** Space left above a turn's first message after jumping to it. */
const LANDING_MARGIN_PX = 24
/** How long scrolling must rest on a turn before followers are told. */
const FOLLOW_DELAY_MS = 100
/** Jumps longer than this many viewports offer a way back. */
const RETURN_THRESHOLD = 1.2
/** Within this distance of the bottom the latest turn is current (matches stick-to-bottom). */
const BOTTOM_SLACK_PX = 40

/** Turns of the visible branch in order; a reply's label is the prompt before it. */
export const buildTranscriptTurns = (
  messages: readonly Message[],
  checkpoints: readonly CompactionCheckpoint[],
  streaming: boolean
): TranscriptTurn[] => {
  const checkpointAnchors = new Set(checkpoints.map((checkpoint) => checkpoint.anchorMessageId))
  const turns: TranscriptTurn[] = []
  let label = ''
  let pendingCheckpoint = false
  messages.forEach((message, index) => {
    if (message.role === 'user') {
      label = excerptOfPrompt(message.content)
    } else {
      turns.push({
        messageId: message.id,
        label,
        live: streaming && index === messages.length - 1,
        activity: hasTurnActivity(message),
        toolCalls: countToolCalls(message),
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
 * The transcript's chapter rail and everything that ties it to scrolling: which turn is being
 * read, jumping and scrubbing between turns, returning to where the reader was, ⌥↑ / ⌥↓ / ⌥←,
 * and reveals requested by the Activity panel. Reports the reading turn to `reading` so sibling
 * views can follow; never scrolls on its own except when asked.
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
  const { reading, deps, requestTurnInspection } = useConversations()
  const follow = useScrollFollow()
  const inspectable = deps.ui.useActiveInspectionTarget !== undefined
  const railRef = useRef<ChapterRailHandle>(null)
  const glideRef = useRef<ScrollGlide | null>(null)
  const topsRef = useRef<number[]>([])
  const lockRef = useRef<number | null>(null)
  const publishTimer = useRef(0)
  const turnsRef = useRef(turns)
  turnsRef.current = turns
  const [current, setCurrent] = useState(Math.max(0, turns.length - 1))
  const currentRef = useRef(current)
  const [returnTo, setReturnTo] = useState<number | null>(null)
  const returnRef = useRef(returnTo)
  returnRef.current = returnTo

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

  const indexAt = (y: number) => {
    let index = 0
    topsRef.current.forEach((top, i) => {
      if (top <= y) {
        index = i
      }
    })
    return index
  }

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
    const tops = topsRef.current
    const position = (y: number) => {
      const index = indexAt(y)
      const start = tops[index] ?? 0
      const end = tops[index + 1] ?? scroll.scrollHeight
      return index + Math.min(1, Math.max(0, (y - start) / Math.max(1, end - start)))
    }
    railRef.current?.setViewport(
      position(scroll.scrollTop),
      position(scroll.scrollTop + scroll.clientHeight)
    )
    if (lockRef.current !== null) {
      return
    }
    const atBottom = scroll.scrollHeight - scroll.scrollTop - scroll.clientHeight < BOTTOM_SLACK_PX
    const index = atBottom
      ? turnsRef.current.length - 1
      : indexAt(scroll.scrollTop + scroll.clientHeight * READING_LINE)
    if (index !== currentRef.current) {
      setCurrentIndex(index)
      publish(index, 'reader', false)
    }
    if (returnRef.current === index) {
      setReturnTo(null)
    }
  }
  const paintRef = useRef(paint)
  paintRef.current = paint

  // Scroll frames repaint the rail; the reader's own input releases a navigation lock.
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
    setReturnTo(null)
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
        setReturnTo(from)
      }
      follow.stop()
      lockRef.current = index
      setCurrentIndex(index)
      publish(index, cause, true)
      glideRef.current?.to(target, {
        instant,
        fade: contentRef.current,
        ...(landing ? { onDone: () => land(turn.messageId) } : {}),
      })
    },
    [scrollRef, contentRef, measure, follow, publish, land]
  )

  const goLatest = useCallback(
    (cause: ReadingCause) => {
      const scroll = scrollRef.current
      if (!scroll) {
        return
      }
      lockRef.current = null
      setReturnTo(null)
      publish(turnsRef.current.length - 1, cause, true)
      glideRef.current?.to(scroll.scrollHeight, {
        fade: contentRef.current,
        onDone: () => follow.sync(),
      })
    },
    [scrollRef, contentRef, publish, follow]
  )

  const returnBack = useCallback(() => {
    const target = returnRef.current
    if (target === null) {
      return
    }
    setReturnTo(null)
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
    if (reveal.target.kind === 'latest') {
      goLatest('reveal')
      return
    }
    const { messageId } = reveal.target
    const index = turnsRef.current.findIndex((turn) => turn.messageId === messageId)
    if (index >= 0) {
      navigate(index, { offerReturn: false, cause: 'reveal' })
    }
  }, [reveal, sessionId, navigate, goLatest])

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

  const items = useMemo(
    (): ChapterRailItem[] =>
      turns.map((turn, index) => {
        const number = index + 1
        const label = turn.label || t('chapterContinued')
        return {
          key: turn.messageId,
          label,
          accessibleLabel: t('chapterLabel', { number, prompt: label }),
          live: turn.live,
          ...(turn.afterCheckpoint ? { dividerBefore: t('chapterContextSummarized') } : {}),
          ...(inspectable && turn.activity
            ? {
                action: (
                  <Tooltip content={t('activityOpenInPanel')} placement="top">
                    <button
                      type="button"
                      className={styles.activityChip}
                      aria-label={t('chapterOpenActivity', { number })}
                      onClick={() => requestTurnInspection(sessionId, turn.messageId, 'activity')}
                    >
                      <IconActivityOutline16 />
                      {turn.toolCalls > 0 ? <span>{turn.toolCalls}</span> : null}
                    </button>
                  </Tooltip>
                ),
              }
            : {}),
        }
      }),
    [turns, inspectable, sessionId, requestTurnInspection, t]
  )

  return (
    <div className={styles.gutter}>
      <ChapterRail
        ref={railRef}
        className={styles.rail}
        items={items}
        current={Math.min(current, Math.max(0, turns.length - 1))}
        ariaLabel={t('chapterRailLabel')}
        returnTo={
          returnTo === null || returnTo >= turns.length
            ? null
            : {
                index: returnTo,
                label: t('chapterReturn', { number: returnTo + 1 }),
                onReturn: returnBack,
              }
        }
        onNavigate={(index, how) =>
          navigate(index, {
            instant: how === 'scrub',
            landing: how === 'jump',
            offerReturn: how === 'jump',
          })
        }
        onScrubEnd={(index, from) => {
          const scroll = scrollRef.current
          const start = topsRef.current[from] ?? 0
          const end = topsRef.current[index] ?? 0
          if (
            scroll &&
            index !== from &&
            Math.abs(end - start) > scroll.clientHeight * RETURN_THRESHOLD
          ) {
            setReturnTo(from)
          }
          const turn = turnsRef.current[index]
          if (turn) {
            land(turn.messageId)
          }
        }}
      />
    </div>
  )
}
