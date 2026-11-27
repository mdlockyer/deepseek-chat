import { useCallback, useLayoutEffect, useRef, useState } from 'react'
import { useTranslate, type Session } from '../../../../kernel/index.js'
import { useConversations } from '../../context.js'
import type { SiderMode } from '../../views.js'
import { ChatInput } from '../chatInput/ChatInput.js'
import { readDurationMs, readMotionToken } from '../messages/motion.js'
import styles from './ChatStage.module.css'
import { SessionView } from './SessionView.js'
import { WelcomeAbove, WelcomeBelow } from './Welcome.js'

/**
 * How the stage changed between two renders.
 * - `launch`: the first message was sent from the new-chat screen; the composer travels down.
 * - `home`: a conversation gave way to the new-chat screen; the composer travels back up.
 * - `open`: an existing conversation was opened from the new-chat screen; crossfade.
 * - `swap`: one conversation replaced another; crossfade the list.
 */
type StageTransition = 'launch' | 'home' | 'open' | 'swap'

/** Which marked elements (`data-stage-exit`) leave as fading copies in each transition. */
const EXITS: Record<StageTransition, readonly string[]> = {
  launch: ['brand', 'greeting', 'below'],
  home: ['title', 'actions', 'list'],
  open: ['brand', 'greeting', 'below', 'composer'],
  swap: ['list'],
}

/** Longest entrance (caveat: 440 ms delay + 180 ms), with margin, before the marker is cleared. */
const SETTLE_MS = 900

type Ghost = { name: string; node: HTMLElement; rect: DOMRect; scrollTop: number }

type Captured = {
  transition: StageTransition
  composer: DOMRect | null
  ghosts: Ghost[]
}

const reducedMotion = () => window.matchMedia('(prefers-reduced-motion: reduce)').matches

/** Copies the elements that are about to leave, with where they are and how far they scrolled. */
const captureExits = (stage: HTMLElement, names: readonly string[]): Ghost[] =>
  names.flatMap((name) =>
    [...stage.querySelectorAll<HTMLElement>(`[data-stage-exit="${name}"]`)].map((el) => ({
      name,
      node: el.cloneNode(true) as HTMLElement,
      rect: el.getBoundingClientRect(),
      scrollTop: el.querySelector<HTMLElement>('[data-message-scroll]')?.scrollTop ?? 0,
    }))
  )

/**
 * The main area: the new-chat screen or a conversation, with one composer between them.
 * The composer is the same element on both screens; when the first message is sent it travels
 * from the centre to the bottom while the greeting leaves and the conversation arrives around
 * it, and it travels back when a new chat is started.
 */
export const ChatStage = ({
  session,
  streaming,
  compacting,
  siderMode,
}: {
  session: Session | undefined
  streaming: boolean
  compacting: boolean
  siderMode: SiderMode
}) => {
  const t = useTranslate()
  const { deps, stopReply } = useConversations()
  const { composerDock: ComposerDock, useHasComposerDock = useNoDock } = deps.ui
  const sessionId = session?.id ?? null
  const hasDock = useHasComposerDock(sessionId ?? '') && sessionId !== null

  const stageRef = useRef<HTMLDivElement | null>(null)
  const slotRef = useRef<HTMLDivElement | null>(null)
  const ghostLayerRef = useRef<HTMLDivElement | null>(null)
  const launchedFromRef = useRef<string | null | undefined>(undefined)
  const capturedRef = useRef<Captured | null>(null)

  const [shown, setShown] = useState(sessionId)
  const [composerKey, setComposerKey] = useState(sessionId === null ? 'new' : `s:${sessionId}`)
  const [transition, setTransition] = useState<{ kind: StageTransition; id: number } | null>(null)
  // The first screen after startup fades in on its own; transitions take over after that.
  const [intro, setIntro] = useState(true)

  // Derive the transition from the previous render. The outgoing DOM is still on screen here,
  // so this is the one moment its copies and the composer's position can be read.
  if (shown !== sessionId) {
    const launched = shown === null && launchedFromRef.current === null
    const kind: StageTransition =
      shown === null ? (launched ? 'launch' : 'open') : sessionId === null ? 'home' : 'swap'
    const stage = stageRef.current
    capturedRef.current = stage
      ? {
          transition: kind,
          composer: slotRef.current?.getBoundingClientRect() ?? null,
          ghosts: captureExits(stage, EXITS[kind]),
        }
      : null
    setShown(sessionId)
    setIntro(false)
    setTransition({ kind, id: (transition?.id ?? 0) + 1 })
    if (!launched) {
      setComposerKey(sessionId === null ? 'new' : `s:${sessionId}`)
    }
  }

  useLayoutEffect(() => {
    const captured = capturedRef.current
    const stage = stageRef.current
    const layer = ghostLayerRef.current
    const slot = slotRef.current
    capturedRef.current = null
    launchedFromRef.current = undefined
    if (!captured || !stage || !layer || !slot || !transition) {
      return
    }
    const reduced = reducedMotion()
    const origin = stage.getBoundingClientRect()
    const cleanups: (() => void)[] = []

    // Outgoing copies fade where they were. Pointer events pass through to the new screen.
    for (const ghost of captured.ghosts) {
      const node = ghost.node
      // Entrance animations belong to the new screen; a copy carrying their markers would replay
      // them instead of fading out.
      node.removeAttribute('data-stage-enter')
      for (const marked of node.querySelectorAll('[data-stage-enter]')) {
        marked.removeAttribute('data-stage-enter')
      }
      node.classList.add(styles.ghost)
      // A copy is only a picture of what left: never focusable or clickable.
      node.inert = true
      node.dataset.ghost = ghost.name
      Object.assign(node.style, {
        top: `${ghost.rect.top - origin.top}px`,
        left: `${ghost.rect.left - origin.left}px`,
        width: `${ghost.rect.width}px`,
        height: `${ghost.rect.height}px`,
      })
      // Copies can hold running animations of their own (a swimming whale); only the copy's
      // own exit ends it.
      const onEnd = (event: AnimationEvent) => {
        if (event.target === node) {
          node.remove()
        }
      }
      node.addEventListener('animationend', onEnd)
      layer.append(node)
      const scroller = node.querySelector<HTMLElement>('[data-message-scroll]')
      if (scroller) {
        scroller.scrollTop = ghost.scrollTop
      }
      cleanups.push(() => node.remove())
    }

    // The composer travels from where it was. Reduced motion crossfades it in place instead.
    const from = captured.composer
    const travels = captured.transition === 'launch' || captured.transition === 'home'
    if (from && travels) {
      const to = slot.getBoundingClientRect()
      const dx = from.left - to.left
      const dy = from.top - to.top
      if (reduced) {
        const fade = slot.animate([{ opacity: 0 }, { opacity: 1 }], {
          duration: 150,
          easing: readMotionToken(slot, '--ui-ease-fade'),
        })
        cleanups.push(() => fade.cancel())
      } else if (Math.abs(dx) > 0.5 || Math.abs(dy) > 0.5) {
        const travel = slot.animate(
          [{ transform: `translate(${dx}px, ${dy}px)` }, { transform: 'none' }],
          {
            duration: readDurationMs(slot, '--ui-duration-spring'),
            easing: readMotionToken(slot, '--ui-ease-spring'),
            // On launch the greeting starts leaving first; the composer follows a beat later.
            delay: captured.transition === 'launch' ? 40 : 0,
            fill: 'backwards',
          }
        )
        cleanups.push(() => travel.cancel())
      }
    }

    const settle = window.setTimeout(() => setTransition(null), SETTLE_MS)
    return () => {
      window.clearTimeout(settle)
      for (const cleanup of cleanups) {
        cleanup()
      }
    }
    // Runs once per transition; `transition.id` changes exactly when one starts.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [transition?.id])

  // Sending from the new-chat composer is what makes the next session change a launch.
  const markSent = useCallback((fromSessionId: string | null) => {
    launchedFromRef.current = fromSessionId
  }, [])

  const mode = session ? 'chat' : 'welcome'
  return (
    <div
      ref={stageRef}
      className={styles.stage}
      data-mode={mode}
      data-transition={transition?.kind}
      data-intro={intro ? '' : undefined}
    >
      {session ? (
        <SessionView
          key="session"
          session={session}
          streaming={streaming}
          compacting={compacting}
          siderMode={siderMode}
        />
      ) : (
        <WelcomeAbove key="above" siderMode={siderMode} />
      )}
      <div key="composer" ref={slotRef} className={styles.composerSlot} data-stage-exit="composer">
        {hasDock && ComposerDock && sessionId !== null ? (
          <>
            <ComposerDock sessionId={sessionId} onStopReply={() => stopReply(sessionId)} />
            <div className={styles.caveat}>{t('contentCaveat')}</div>
          </>
        ) : (
          <ChatInput
            instanceKey={composerKey}
            sessionId={sessionId}
            caveat={session !== undefined}
            onSent={markSent}
          />
        )}
      </div>
      {session ? null : <WelcomeBelow key="below" />}
      <div key="ghosts" ref={ghostLayerRef} className={styles.ghostLayer} aria-hidden="true" />
    </div>
  )
}

const useNoDock = () => false
