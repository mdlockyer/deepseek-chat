import { Markdown } from '@deepseek-chat/lib-markdown'
import type { ToolStepVisualArtifact } from '@deepseek-chat/lib-tools'
import {
  Button,
  EmptyState,
  HoverGlide,
  IconActivityOutline16,
  IconChevronDownOutline14,
  IconChevronRightOutline14,
  IconCloseOutline16,
  IconCodeOutline14,
  IconPhotoOutline14,
  IconThinkOutline16,
  IconButton,
  Tab,
  TabList,
  TabPanel,
  Tabs,
  hoverGlideItem,
} from '@deepseek-chat/lib-ui'
import clsx from 'clsx'
import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  useSyncExternalStore,
  type MouseEvent,
  type ReactNode,
} from 'react'
import { EvidenceShelf } from './EvidenceShelf.js'
import { GenericStepDetail } from './GenericStepView.js'
import { activityInspectorMessages } from './messages.js'
import { SourceCard } from './SourceCard.js'
import type { ActivityPanelState } from './state.js'
import './thinking.markdown.css'
import {
  buildActivityTimeline,
  type ActivityLanePhase,
  type ActivityStepRecord,
  type ActivityThinkingRound,
  type ActivityVisualItem,
} from './timeline.js'
import { TurnSwitcherMenu } from './TurnSwitcherMenu.js'
import type {
  ActivityInspectorDeps,
  ActivitySelection,
  ActivitySource,
  SessionTurnSummary,
  TurnSnapshot,
} from './types.js'
import { VisualLightbox } from './VisualLightbox.js'
import styles from './ActivityPanel.module.css'

const EMPTY_TURNS: readonly SessionTurnSummary[] = []
const EMPTY_VISUALS: readonly ActivityVisualItem[] = []
const AUTO_SCROLL_THRESHOLD_PX = 48

const useLiveElapsedSeconds = (active: boolean, startedAt: number | null): number | null => {
  const [now, setNow] = useState(() => Date.now())
  useEffect(() => {
    if (!active || startedAt === null) {
      return
    }
    setNow(Date.now())
    const timer = setInterval(() => setNow(Date.now()), 1000)
    return () => clearInterval(timer)
  }, [active, startedAt])
  if (!active || startedAt === null) {
    return null
  }
  return Math.max(0, Math.round((now - startedAt) / 1000))
}

const LiveRunningStatus = ({
  streaming,
  startedAt,
  verb,
}: {
  streaming: boolean
  startedAt?: number
  verb: string
}) => {
  const t = activityInspectorMessages.useTranslate()
  const elapsed = useLiveElapsedSeconds(streaming, startedAt ?? null)
  const label =
    elapsed !== null && elapsed >= 2 ? t('stepRunningSeconds', { verb, seconds: elapsed }) : verb
  return <span className={styles.statusRunning}>{label}</span>
}

const ReasoningSection = ({
  messageId,
  rounds,
  staticSeconds,
  completedThinkingMs,
  activeStartedAt,
  defaultOpen,
  loading,
  onInspectStep,
}: {
  messageId: string
  rounds: readonly ActivityThinkingRound[]
  staticSeconds: number | null
  completedThinkingMs: number
  activeStartedAt: number | null
  defaultOpen: boolean
  loading: boolean
  onInspectStep: (callId: string) => void
}) => {
  const t = activityInspectorMessages.useTranslate()
  const [open, setOpen] = useState(defaultOpen)
  const liveDelta = useLiveElapsedSeconds(loading, activeStartedAt)
  const liveTotalSeconds =
    loading && liveDelta !== null
      ? Math.max(1, Math.round(completedThinkingMs / 1000) + liveDelta)
      : staticSeconds

  const heading = loading
    ? liveTotalSeconds !== null
      ? t('reasoningStreamingSeconds', { seconds: liveTotalSeconds })
      : t('reasoningStreaming')
    : staticSeconds !== null
      ? t('reasoningSeconds', { seconds: staticSeconds })
      : t('reasoningTitle')

  const showRoundHeaders = rounds.length >= 2

  return (
    <div className={styles.reasoningBlock}>
      <button
        type="button"
        className={styles.rowButton}
        aria-expanded={open}
        {...hoverGlideItem()}
        onClick={() => setOpen((v) => !v)}
      >
        <span className={styles.rowIcon} aria-hidden="true">
          <IconThinkOutline16 />
        </span>
        <span className={styles.rowHeading}>{heading}</span>
        <span className={styles.rowTrailing}>
          <span className={styles.rowChevron} aria-hidden="true">
            {open ? <IconChevronDownOutline14 /> : <IconChevronRightOutline14 />}
          </span>
        </span>
      </button>
      {open ? (
        <div className={clsx(styles.stepDetail, 'ds-think-content')}>
          {showRoundHeaders ? (
            <div className={styles.reasoningRounds}>
              {rounds.map((round, roundIndex) => {
                const isLast = roundIndex === rounds.length - 1
                const stepCallId = round.nextStepCallId
                const anchorText = round.nextStepLabel
                  ? t('reasoningBeforeStep', { step: round.nextStepLabel })
                  : t('reasoningBeforeReply')
                return (
                  <div key={round.key} className={styles.reasoningRound}>
                    {stepCallId ? (
                      <button
                        type="button"
                        className={styles.roundAnchorButton}
                        onClick={() => onInspectStep(stepCallId)}
                      >
                        {anchorText}
                      </button>
                    ) : (
                      <div className={styles.roundAnchorLabel}>{anchorText}</div>
                    )}
                    <Markdown
                      content={round.markdown}
                      loading={loading && isLast}
                      cacheKey={`${messageId}-${round.key}`}
                      disableLink={false}
                    />
                  </div>
                )
              })}
            </div>
          ) : rounds[0] ? (
            <Markdown
              content={rounds[0].markdown}
              loading={loading}
              cacheKey={`${messageId}-think`}
              disableLink={false}
            />
          ) : null}
        </div>
      ) : null}
    </div>
  )
}

const ActivityStepRow = ({
  item,
  phase,
  sessionId,
  streaming,
  capabilityState,
  open,
  selected,
  onToggle,
  openLink,
  openFile,
  openVisual,
  renderMarkdown,
}: {
  item: ActivityStepRecord
  phase: ActivityLanePhase
  sessionId: string
  streaming: boolean
  capabilityState: unknown
  open: boolean
  selected: boolean
  onToggle: () => void
  openLink: (event: MouseEvent, url: string) => void
  openFile?: ActivityInspectorDeps['openFile']
  openVisual: (visual: ToolStepVisualArtifact) => void
  renderMarkdown: (props: { readonly content: string; readonly cacheKey: string }) => ReactNode
}) => {
  const t = activityInspectorMessages.useTranslate()
  const DetailView = phase.presenter?.renderStepDetail ?? GenericStepDetail
  const icon = item.summary?.icon ?? <IconCodeOutline14 />
  const visualCount = item.visuals.length
  const visualTitle =
    visualCount === 1
      ? t('visualBadgeOne')
      : visualCount > 1
        ? t('visualBadgeMany', { count: visualCount })
        : undefined
  const runningVerb =
    item.entry.result?.progress?.detail || item.summary?.liveVerb || t('stepStatusRunning')

  const rowContent = (
    <>
      <span
        className={clsx(styles.rowIcon, item.status === 'error' && styles.rowIconError)}
        aria-hidden="true"
      >
        {icon}
      </span>
      <span className={clsx(styles.rowLabel, item.status === 'running' && styles.rowLabelActive)}>
        {item.label}
      </span>
      {item.status === 'error' ? (
        <span className={styles.srOnly}> ({t('stepStatusFailed')})</span>
      ) : null}
      {visualTitle && item.status !== 'running' ? (
        <span className={styles.srOnly}> ({visualTitle})</span>
      ) : null}
      <span className={styles.rowTrailing}>
        {item.status === 'running' ? (
          <LiveRunningStatus
            streaming={streaming}
            startedAt={item.entry.result?.startedAt}
            verb={runningVerb}
          />
        ) : (
          <>
            {visualCount > 0 ? (
              <span className={styles.visualIndicator} title={visualTitle} aria-hidden="true">
                <IconPhotoOutline14 />
                {visualCount > 1 ? <span>{visualCount}</span> : null}
              </span>
            ) : null}
            {item.summary?.meta ? (
              <span className={styles.rowMeta}>{item.summary.meta}</span>
            ) : null}
          </>
        )}
        {item.hasDetail ? (
          <span className={styles.rowChevron} aria-hidden="true">
            {open ? <IconChevronDownOutline14 /> : <IconChevronRightOutline14 />}
          </span>
        ) : null}
      </span>
    </>
  )

  return (
    <div
      className={clsx(styles.stepBlock, selected && styles.stepSelected)}
      data-activity-call-id={item.callId}
      data-activity-selected={selected ? 'true' : undefined}
    >
      {item.hasDetail ? (
        <button
          type="button"
          className={clsx(
            styles.rowButton,
            open && styles.rowButtonOpen,
            open && selected && styles.rowButtonSelected
          )}
          title={item.label}
          aria-expanded={open}
          {...hoverGlideItem(open && selected)}
          onClick={onToggle}
        >
          {rowContent}
        </button>
      ) : (
        <div
          className={clsx(styles.rowStatic, selected && styles.rowButtonSelected)}
          title={item.label}
        >
          {rowContent}
        </div>
      )}
      {item.hasDetail && open ? (
        <div className={styles.stepDetail}>
          {item.precedingNote ? (
            <div className={clsx(styles.precedingNote, 'ds-activity-note')}>
              <Markdown
                content={item.precedingNote}
                loading={false}
                cacheKey={`${item.callId}-note`}
                disableLink={false}
              />
            </div>
          ) : null}
          <DetailView
            sessionId={sessionId}
            entry={item.entry}
            streaming={streaming}
            now={Date.now()}
            capabilityState={capabilityState}
            openLink={openLink}
            openFile={openFile}
            openVisual={openVisual}
            renderMarkdown={renderMarkdown}
          />
        </div>
      ) : null}
    </div>
  )
}

const SourcesView = ({
  cited,
  other,
  all,
  onOpenLink,
}: {
  cited: ActivitySource[]
  other: ActivitySource[]
  all: ActivitySource[]
  onOpenLink: (event: MouseEvent, url: string) => void
}) => {
  const t = activityInspectorMessages.useTranslate()
  if (cited.length === 0) {
    return (
      <div className={styles.sourceSection}>
        {all.map((source) => (
          <SourceCard
            key={source.url}
            source={source}
            className={styles.sourceItem}
            onOpenLink={onOpenLink}
          />
        ))}
      </div>
    )
  }
  return (
    <div className={styles.sourceSections}>
      <section className={styles.sourceSection} aria-label={t('citedHeading')}>
        <div className={styles.sourceSectionHeading}>
          {t('citedHeading')} ({cited.length})
        </div>
        {cited.map((source) => (
          <SourceCard
            key={source.url}
            source={source}
            citationIndex={source.index}
            className={styles.sourceItem}
            onOpenLink={onOpenLink}
          />
        ))}
      </section>
      {other.length > 0 ? (
        <section className={styles.sourceSection} aria-label={t('otherSourcesHeading')}>
          <div className={styles.sourceSectionHeading}>
            {t('otherSourcesHeading')} ({other.length})
          </div>
          {other.map((source) => (
            <SourceCard
              key={source.url}
              source={source}
              className={styles.sourceItem}
              onOpenLink={onOpenLink}
            />
          ))}
        </section>
      ) : null}
    </div>
  )
}

export const createActivityPanel = (state: ActivityPanelState, deps: ActivityInspectorDeps) => {
  const renderMarkdown = ({
    content,
    cacheKey,
  }: {
    readonly content: string
    readonly cacheKey: string
  }) => <Markdown content={content} loading={false} cacheKey={cacheKey} disableLink={false} />

  const ActivityPanel = ({ topActions }: { topActions?: ReactNode } = {}) => {
    const t = activityInspectorMessages.useTranslate()
    const selection = state.useStore((s) => s.selection)
    const layoutSessionId = deps.panel.useLayout((layout) => layout.activeSessionId)
    const lastSelectionRef = useRef<ActivitySelection | null>(selection)
    if (selection) {
      lastSelectionRef.current = selection
    }
    const activeSelection = selection ?? lastSelectionRef.current
    const sessionId = activeSelection?.sessionId ?? layoutSessionId

    const getTurns = useCallback((): readonly SessionTurnSummary[] => {
      if (!sessionId || !deps.turnSource.listTurns) {
        return EMPTY_TURNS
      }
      return deps.turnSource.listTurns(sessionId)
    }, [sessionId])

    const allTurns = useSyncExternalStore(deps.turnSource.subscribe, getTurns, getTurns)
    const activityTurns = useMemo(
      () => allTurns.filter((item) => item.hasActivity || item.streaming),
      [allTurns]
    )

    const latestTurnId = useMemo(() => {
      const streamingTurn = [...activityTurns].reverse().find((item) => item.streaming)
      return streamingTurn?.messageId ?? activityTurns.at(-1)?.messageId ?? null
    }, [activityTurns])

    const resolvedMessageId = useMemo(() => {
      if (activeSelection?.kind === 'pinned') {
        return activeSelection.messageId
      }
      return latestTurnId
    }, [activeSelection, latestTurnId])

    const cachedTurnRef = useRef<TurnSnapshot | null>(null)
    const getSnapshot = useCallback((): TurnSnapshot | null => {
      if (!sessionId || !resolvedMessageId) {
        cachedTurnRef.current = null
        return null
      }
      const next = deps.turnSource.getTurn(sessionId, resolvedMessageId)
      const prev = cachedTurnRef.current
      if (prev === next) {
        return prev
      }
      if (
        prev &&
        next &&
        prev.sessionId === next.sessionId &&
        prev.messageId === next.messageId &&
        prev.status === next.status &&
        prev.streaming === next.streaming &&
        prev.blocks === next.blocks &&
        prev.capabilityState === next.capabilityState
      ) {
        return prev
      }
      cachedTurnRef.current = next
      return next
    }, [sessionId, resolvedMessageId])

    const turn = useSyncExternalStore(deps.turnSource.subscribe, getSnapshot, getSnapshot)
    const live = Boolean(turn && turn.streaming && turn.status === 'streaming')

    const timeline = useMemo(
      () => (turn ? buildActivityTimeline(turn, deps.getPresenter) : null),
      [turn]
    )

    const openLink = useCallback((event: MouseEvent, url: string) => {
      if (deps.openInApp && /^https?:\/\//i.test(url)) {
        event.preventDefault()
        deps.openInApp(url)
      }
    }, [])

    const hasSources = (timeline?.sources.all.length ?? 0) > 0
    const effectiveTab = hasSources ? (activeSelection?.tab ?? 'activity') : 'activity'
    const focusedCallId =
      activeSelection?.kind === 'pinned' ? (activeSelection.focusedCallId ?? null) : null
    const focusNonce = activeSelection?.kind === 'pinned' ? (activeSelection.focusNonce ?? 0) : 0
    const contentRef = useRef<HTMLDivElement | null>(null)
    const pinnedToBottomRef = useRef(true)

    const [openStepIds, setOpenStepIds] = useState<ReadonlySet<string>>(() =>
      focusedCallId ? new Set([focusedCallId]) : new Set()
    )
    const [selectedCallId, setSelectedCallId] = useState<string | null>(focusedCallId)
    const [scrollTarget, setScrollTarget] = useState<{ callId: string; nonce: number } | null>(() =>
      focusedCallId ? { callId: focusedCallId, nonce: focusNonce } : null
    )
    const [lightboxState, setLightboxState] = useState<{
      index: number
      fallback?: ActivityVisualItem
    } | null>(null)
    const localScrollNonceRef = useRef(0)

    const prevTurnIdRef = useRef<string | null>(turn?.messageId ?? null)
    useEffect(() => {
      const nextTurnId = turn?.messageId ?? null
      if (prevTurnIdRef.current !== nextTurnId) {
        prevTurnIdRef.current = nextTurnId
        setOpenStepIds(focusedCallId ? new Set([focusedCallId]) : new Set())
        setSelectedCallId(focusedCallId)
        setScrollTarget(focusedCallId ? { callId: focusedCallId, nonce: focusNonce } : null)
        setLightboxState(null)
        pinnedToBottomRef.current = true
      }
    }, [turn?.messageId, focusedCallId, focusNonce])

    useEffect(() => {
      if (!focusedCallId) {
        return
      }
      setSelectedCallId(focusedCallId)
      setOpenStepIds((prev) => {
        if (prev.has(focusedCallId)) {
          return prev
        }
        const next = new Set(prev)
        next.add(focusedCallId)
        return next
      })
      setScrollTarget({ callId: focusedCallId, nonce: focusNonce })
    }, [focusedCallId, focusNonce])

    useEffect(() => {
      if (!scrollTarget || effectiveTab !== 'activity') {
        return
      }
      const container = contentRef.current
      if (!container) {
        return
      }
      const escapeAttr = (value: string) =>
        typeof CSS !== 'undefined' && typeof CSS.escape === 'function'
          ? CSS.escape(value)
          : value.replace(/["\\]/g, '\\$&')
      const frameId = requestAnimationFrame(() => {
        const found = container.querySelector<HTMLElement>(
          `[data-activity-call-id="${escapeAttr(scrollTarget.callId)}"]`
        )
        if (!found) {
          return
        }
        const reducedMotion =
          typeof window !== 'undefined' &&
          typeof window.matchMedia === 'function' &&
          window.matchMedia('(prefers-reduced-motion: reduce)').matches
        found.scrollIntoView({ block: 'nearest', behavior: reducedMotion ? 'auto' : 'smooth' })
      })
      return () => cancelAnimationFrame(frameId)
    }, [scrollTarget, effectiveTab, turn?.messageId])

    const handleContentScroll = useCallback(() => {
      const el = contentRef.current
      if (!el) {
        return
      }
      pinnedToBottomRef.current =
        el.scrollHeight - el.scrollTop - el.clientHeight <= AUTO_SCROLL_THRESHOLD_PX
    }, [])

    const stepCount = timeline?.stepCount ?? 0
    const prevStepCountRef = useRef(stepCount)
    useEffect(() => {
      const grew = stepCount > prevStepCountRef.current
      prevStepCountRef.current = stepCount
      if (!live || !grew || scrollTarget || !pinnedToBottomRef.current) {
        return
      }
      const el = contentRef.current
      if (!el) {
        return
      }
      el.scrollTop = el.scrollHeight
    }, [live, scrollTarget, stepCount])

    const toggleStep = useCallback(
      (callId: string) => {
        const closing = openStepIds.has(callId)
        setOpenStepIds((prev) => {
          const next = new Set(prev)
          if (next.has(callId)) {
            next.delete(callId)
          } else {
            next.add(callId)
          }
          return next
        })
        setSelectedCallId((current) => (closing ? (current === callId ? null : current) : callId))
      },
      [openStepIds]
    )

    const inspectStep = useCallback((callId: string) => {
      setSelectedCallId(callId)
      setOpenStepIds((prev) => {
        const next = new Set(prev)
        next.add(callId)
        return next
      })
      localScrollNonceRef.current += 1
      setScrollTarget({ callId, nonce: -localScrollNonceRef.current })
    }, [])

    const timelineVisuals = timeline?.visuals ?? EMPTY_VISUALS
    const openVisualAt = useCallback((index: number) => {
      setLightboxState({ index })
    }, [])

    const openVisualForStep = useCallback(
      (callId: string, stepLabel: string, visual: ToolStepVisualArtifact) => {
        const exact = timelineVisuals.findIndex(
          (item) => item.callId === callId && item.src === visual.src
        )
        if (exact >= 0) {
          setLightboxState({ index: exact })
          return
        }
        const bySrc = timelineVisuals.findIndex((item) => item.src === visual.src)
        if (bySrc >= 0) {
          setLightboxState({ index: bySrc })
          return
        }
        setLightboxState({
          index: 0,
          fallback: {
            key: `${callId}-fallback`,
            callId,
            stepLabel,
            src: visual.src,
            alt: visual.alt,
            ...(visual.caption ? { caption: visual.caption } : {}),
            ...(visual.href ? { href: visual.href } : {}),
          },
        })
      },
      [timelineVisuals]
    )

    const isPinnedBehindLatest = Boolean(
      sessionId &&
      activeSelection?.kind === 'pinned' &&
      latestTurnId &&
      latestTurnId !== resolvedMessageId
    )

    const renderActivityBody = () => {
      if (!turn || !timeline) {
        return (
          <div className={styles.emptyWrap}>
            <EmptyState
              compact
              icon={<IconActivityOutline16 />}
              title={t('emptyTitle')}
              description={activityTurns.length === 0 ? t('emptySession') : t('empty')}
            />
          </div>
        )
      }
      if (timeline.phases.length === 0 && timeline.thinkingRounds.length === 0) {
        return (
          <div className={styles.emptyWrap}>
            <EmptyState
              compact
              icon={<IconActivityOutline16 />}
              title={t('emptyTitle')}
              description={t('empty')}
            />
          </div>
        )
      }

      const hasReasoning = timeline.thinkingRounds.length > 0
      const activeReasoning =
        live &&
        timeline.activeThinkingStartedAt !== null &&
        timeline.thinkingBlocks.at(-1)?.endedAt === undefined

      return (
        <div className={styles.bodyStack}>
          <EvidenceShelf
            files={timeline.files}
            visuals={timeline.visuals}
            onOpenFile={deps.openFile ? (file) => deps.openFile?.(turn.sessionId, file) : undefined}
            onOpenVisual={openVisualAt}
          />

          <HoverGlide className={styles.stream}>
            {hasReasoning ? (
              <ReasoningSection
                key={`${turn.messageId}-reasoning`}
                messageId={turn.messageId}
                rounds={timeline.thinkingRounds}
                staticSeconds={timeline.thinkingSeconds}
                completedThinkingMs={timeline.completedThinkingMs}
                activeStartedAt={timeline.activeThinkingStartedAt}
                defaultOpen={timeline.thinkingOnly}
                loading={activeReasoning}
                onInspectStep={inspectStep}
              />
            ) : null}

            {timeline.phases.map((phase, index) => {
              const capState = phase.capabilityId
                ? turn.capabilityState?.[phase.capabilityId]
                : undefined
              if (
                phase.presenter &&
                !phase.presenter.renderStepDetail &&
                phase.presenter.renderActivity
              ) {
                const CustomView = phase.presenter.renderActivity
                return (
                  <div key={phase.key} className={styles.customPhase}>
                    <CustomView
                      sessionId={turn.sessionId}
                      lane={phase.lane}
                      entries={phase.entries}
                      streaming={live}
                      now={Date.now()}
                      capabilityState={capState}
                      openLink={openLink}
                      openFile={deps.openFile}
                      renderMarkdown={renderMarkdown}
                      focusedCallId={focusedCallId}
                      focusNonce={focusNonce}
                    />
                  </div>
                )
              }
              const prevPhase = index > 0 ? timeline.phases[index - 1] : null
              const laneShift = prevPhase?.type === 'lane' && prevPhase.lane !== phase.lane
              return (
                <div
                  key={phase.key}
                  className={clsx(styles.stepGroup, laneShift && styles.laneGap)}
                >
                  {phase.items.map((item) => (
                    <ActivityStepRow
                      key={item.callId}
                      item={item}
                      phase={phase}
                      sessionId={turn.sessionId}
                      streaming={live}
                      capabilityState={capState}
                      open={openStepIds.has(item.callId)}
                      selected={selectedCallId === item.callId}
                      onToggle={() => toggleStep(item.callId)}
                      openLink={openLink}
                      openFile={deps.openFile}
                      openVisual={(visual) => openVisualForStep(item.callId, item.label, visual)}
                      renderMarkdown={renderMarkdown}
                    />
                  ))}
                </div>
              )
            })}
          </HoverGlide>
        </div>
      )
    }

    const liveBadge = live ? (
      <span className={styles.liveBadge} role="status" aria-live="polite">
        <span className={styles.liveDot} aria-hidden="true" />
        <span>{t('liveStatus')}</span>
      </span>
    ) : null

    const lightboxVisuals = lightboxState?.fallback ? [lightboxState.fallback] : timelineVisuals

    return (
      <Tabs value={effectiveTab} onChange={state.setTab} className={styles.root}>
        <header className={styles.header} data-tauri-drag-region="">
          <div className={styles.headerLeading} data-tauri-drag-region="">
            {hasSources && timeline ? (
              <>
                <h2 className={styles.srOnly}>{t('panelTitle')}</h2>
                <TabList
                  ariaLabel={t('panelTitle')}
                  variant="underline"
                  className={styles.headerTabs}
                >
                  <Tab value="activity">{t('tabSteps')}</Tab>
                  <Tab
                    value="sources"
                    badge={<span className={styles.tabCount}>{timeline.sources.all.length}</span>}
                  >
                    {t('tabSources')}
                  </Tab>
                </TabList>
              </>
            ) : (
              <h2 className={styles.title} data-tauri-drag-region="">
                {t('panelTitle')}
              </h2>
            )}

            {sessionId && resolvedMessageId && activityTurns.length >= 2 ? (
              <TurnSwitcherMenu
                turns={activityTurns}
                activeMessageId={resolvedMessageId}
                onSelect={(nextMessageId) => state.selectTurn(sessionId, nextMessageId)}
              />
            ) : null}

            {isPinnedBehindLatest && sessionId ? (
              <Button
                variant="ghost"
                size="s"
                className={styles.latestButton}
                aria-label={t('followLatestLabel')}
                onClick={() => state.followLatest(sessionId)}
              >
                {t('followLatest')}
              </Button>
            ) : null}

            {liveBadge}
          </div>

          <div className={styles.topActions}>
            {topActions}
            <IconButton
              size="xs"
              icon={<IconCloseOutline16 />}
              tooltip={t('close')}
              tooltipPlacement="bottom"
              aria-label={t('close')}
              onClick={state.close}
            />
          </div>
        </header>

        <TabPanel value="activity" keepMounted plain={!hasSources} className={styles.tabPanel}>
          <div ref={contentRef} className={styles.content} onScroll={handleContentScroll}>
            {renderActivityBody()}
          </div>
        </TabPanel>

        {hasSources && timeline ? (
          <TabPanel value="sources" keepMounted className={styles.tabPanel}>
            <div className={styles.content}>
              <SourcesView
                cited={timeline.sources.cited}
                other={timeline.sources.other}
                all={timeline.sources.all}
                onOpenLink={openLink}
              />
            </div>
          </TabPanel>
        ) : null}

        <VisualLightbox
          visuals={lightboxVisuals}
          activeIndex={lightboxState?.index ?? null}
          onChangeIndex={(nextIndex) =>
            setLightboxState((prev) => (prev ? { ...prev, index: nextIndex } : null))
          }
          onClose={() => setLightboxState(null)}
          onInspectStep={inspectStep}
          onOpenLink={openLink}
        />
      </Tabs>
    )
  }

  return ActivityPanel
}
