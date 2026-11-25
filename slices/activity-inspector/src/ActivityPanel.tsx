import { Markdown } from '@deepseek-chat/lib-markdown'
import {
  Button,
  Chip,
  EmptyState,
  HoverGlide,
  IconActivityOutline16,
  IconChevronDownOutline14,
  IconChevronRightOutline14,
  IconCloseOutline16,
  IconCodeOutline14,
  IconOpenExternalOutline14,
  IconPhotoOutline14,
  IconSearchOutline16,
  IconThinkOutline16,
  IconWarningOutline16,
  IconButton,
  Select,
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
import { GenericStepDetail } from './GenericStepView.js'
import { activityInspectorMessages } from './messages.js'
import { SourceCard } from './SourceCard.js'
import type { ActivityPanelState } from './state.js'
import './thinking.markdown.css'
import {
  buildActivityTimeline,
  type ActivityLanePhase,
  type ActivityStepRecord,
  type ActivityTimeline,
  type ActivityVisualItem,
} from './timeline.js'
import type {
  ActivityInspectorDeps,
  ActivitySelection,
  ActivitySource,
  SessionTurnSummary,
  TurnSnapshot,
} from './types.js'
import styles from './ActivityPanel.module.css'

type ActivityFilter = 'all' | 'visuals' | 'errors'

const EMPTY_TURNS: readonly SessionTurnSummary[] = []
const LONG_PREAMBLE_CHARS = 240
const LONG_PREAMBLE_LINES = 3
const MAX_EXPAND_ALL_STEPS = 12
const STAGED_FILTER_MIN_STEPS = 8

const useTicker = (active: boolean, interval: number) => {
  const [tick, setTick] = useState(0)
  useEffect(() => {
    if (!active) {
      return
    }
    const timer = setInterval(() => setTick((value) => value + 1), interval)
    return () => clearInterval(timer)
  }, [active, interval])
  return tick
}

const ReasoningSection = ({
  messageId,
  markdown,
  seconds,
  defaultOpen,
  loading,
}: {
  messageId: string
  markdown: string
  seconds: number | null
  defaultOpen: boolean
  loading: boolean
}) => {
  const t = activityInspectorMessages.useTranslate()
  const [open, setOpen] = useState(defaultOpen)
  const heading = loading
    ? t('reasoningStreaming')
    : seconds !== null
      ? t('reasoningSeconds', { seconds })
      : t('reasoningTitle')

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
          <Markdown
            content={markdown}
            loading={loading}
            cacheKey={`${messageId}-think`}
            disableLink={false}
          />
        </div>
      ) : null}
    </div>
  )
}

const PreambleBeat = ({
  cacheKey,
  markdown,
  hasPreviousContent,
}: {
  cacheKey: string
  markdown: string
  hasPreviousContent: boolean
}) => {
  const t = activityInspectorMessages.useTranslate()
  const isLong =
    markdown.length > LONG_PREAMBLE_CHARS || markdown.split('\n').length > LONG_PREAMBLE_LINES
  const [expanded, setExpanded] = useState(false)

  return (
    <div className={clsx(styles.preambleBeat, hasPreviousContent && styles.beatGap)}>
      <div
        className={clsx(
          styles.preambleBody,
          'ds-think-content',
          'ds-activity-preamble',
          isLong && !expanded && styles.preambleClamped
        )}
      >
        <Markdown content={markdown} loading={false} cacheKey={cacheKey} disableLink={false} />
      </div>
      {isLong ? (
        <button
          type="button"
          className={styles.noteMoreButton}
          onClick={() => setExpanded((value) => !value)}
        >
          {expanded ? t('showLessNote') : t('showMoreNote')}
        </button>
      ) : null}
    </div>
  )
}

const ServerSearchRow = ({
  queries,
  pages,
  openLink,
}: {
  queries: readonly string[]
  pages: readonly { readonly url: string; readonly title: string }[]
  openLink: (event: MouseEvent, url: string) => void
}) => {
  const t = activityInspectorMessages.useTranslate()
  const [open, setOpen] = useState(false)
  const count = queries.length + pages.length
  const hasDetails = count > 0

  return (
    <div className={styles.stepBlock}>
      <button
        type="button"
        className={styles.rowButton}
        aria-expanded={open}
        disabled={!hasDetails}
        {...hoverGlideItem()}
        onClick={() => setOpen((v) => !v)}
      >
        <span className={styles.rowIcon} aria-hidden="true">
          <IconSearchOutline16 />
        </span>
        <span className={styles.rowLabel}>{t('serverSearchTitle')}</span>
        <span className={styles.rowTrailing}>
          {count > 0 ? <span className={styles.rowMeta}>{count}</span> : null}
          {hasDetails ? (
            <span className={styles.rowChevron} aria-hidden="true">
              {open ? <IconChevronDownOutline14 /> : <IconChevronRightOutline14 />}
            </span>
          ) : null}
        </span>
      </button>
      {open && hasDetails ? (
        <div className={styles.stepDetail}>
          {queries.length > 0 ? (
            <div className={styles.queryList}>
              {queries.map((q) => (
                <div key={q} className={styles.queryChip}>
                  “{q}”
                </div>
              ))}
            </div>
          ) : null}
          {pages.length > 0 ? (
            <div className={styles.serverPageList}>
              {pages.map((page) => (
                <a
                  key={page.url}
                  className={styles.serverPageLink}
                  href={page.url}
                  target="_blank"
                  rel="noreferrer"
                  onClick={(event) => openLink(event, page.url)}
                >
                  <span className={styles.serverPageText}>{page.title || page.url}</span>
                  <IconOpenExternalOutline14 />
                </a>
              ))}
            </div>
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
  now,
  capabilityState,
  open,
  selected,
  onToggle,
  openLink,
  openFile,
  renderMarkdown,
}: {
  item: ActivityStepRecord
  phase: ActivityLanePhase
  sessionId: string
  streaming: boolean
  now: number
  capabilityState: unknown
  open: boolean
  selected: boolean
  onToggle: () => void
  openLink: (event: MouseEvent, url: string) => void
  openFile?: ActivityInspectorDeps['openFile']
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

  const rowContent = (
    <>
      <span className={styles.rowIcon} aria-hidden="true">
        {icon}
      </span>
      <span className={clsx(styles.rowLabel, item.status === 'running' && styles.rowLabelActive)}>
        {item.label}
      </span>
      <span className={styles.rowTrailing}>
        {item.status === 'running' ? (
          <span className={styles.statusRunning}>{t('stepStatusRunning')}</span>
        ) : item.status === 'error' ? (
          <span className={styles.statusError}>
            <IconWarningOutline16 />
            <span>{t('stepStatusFailed')}</span>
          </span>
        ) : (
          <>
            {visualCount > 0 ? (
              <span className={styles.visualTag} title={visualTitle} aria-label={visualTitle}>
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
          className={clsx(styles.rowButton, selected && styles.rowButtonSelected)}
          aria-expanded={open}
          {...hoverGlideItem(selected)}
          onClick={onToggle}
        >
          {rowContent}
        </button>
      ) : (
        <div className={clsx(styles.rowStatic, selected && styles.rowButtonSelected)}>
          {rowContent}
        </div>
      )}
      {item.hasDetail && open ? (
        <div className={styles.stepDetail}>
          <DetailView
            sessionId={sessionId}
            entry={item.entry}
            streaming={streaming}
            now={now}
            capabilityState={capabilityState}
            openLink={openLink}
            openFile={openFile}
            renderMarkdown={renderMarkdown}
          />
        </div>
      ) : null}
    </div>
  )
}

const VisualStoryboard = ({
  visuals,
  onInspectStep,
  onOpenLink,
}: {
  visuals: readonly ActivityVisualItem[]
  onInspectStep: (callId: string) => void
  onOpenLink: (event: MouseEvent, url: string) => void
}) => {
  const t = activityInspectorMessages.useTranslate()
  return (
    <div className={styles.storyboard}>
      {visuals.map((visual) => {
        const href = visual.href
        return (
          <figure key={visual.key} className={styles.storyboardCard}>
            <img src={visual.src} alt={visual.alt} className={styles.storyboardImage} />
            <figcaption className={styles.storyboardCaption}>
              <button
                type="button"
                className={styles.storyboardStepLink}
                title={t('viewStepInTimeline')}
                onClick={() => onInspectStep(visual.callId)}
              >
                {visual.caption ?? visual.stepLabel}
              </button>
              {href ? (
                <a
                  className={styles.storyboardExternalLink}
                  href={href}
                  target="_blank"
                  rel="noreferrer"
                  aria-label={href}
                  onClick={(event) => onOpenLink(event, href)}
                >
                  <IconOpenExternalOutline14 />
                </a>
              ) : null}
            </figcaption>
          </figure>
        )
      })}
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

const allExpandableCallIds = (timeline: ActivityTimeline): string[] => {
  const ids: string[] = []
  for (const phase of timeline.phases) {
    if (phase.type === 'lane' && (!phase.presenter || phase.presenter.renderStepDetail)) {
      for (const item of phase.items) {
        if (item.hasDetail) {
          ids.push(item.callId)
        }
      }
    }
  }
  return ids
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
    const tick = useTicker(live, 1000)
    const now = Date.now() + tick * 0

    const timeline = useMemo(
      () => (turn ? buildActivityTimeline(turn, deps.getPresenter, now) : null),
      [turn, now]
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

    const [filter, setFilter] = useState<ActivityFilter>('all')
    const [openStepIds, setOpenStepIds] = useState<ReadonlySet<string>>(() =>
      focusedCallId ? new Set([focusedCallId]) : new Set()
    )
    const [selectedCallId, setSelectedCallId] = useState<string | null>(focusedCallId)
    const [scrollTarget, setScrollTarget] = useState<{ callId: string; nonce: number } | null>(() =>
      focusedCallId ? { callId: focusedCallId, nonce: focusNonce } : null
    )
    const localScrollNonceRef = useRef(0)

    const prevTurnIdRef = useRef<string | null>(turn?.messageId ?? null)
    useEffect(() => {
      const nextTurnId = turn?.messageId ?? null
      if (prevTurnIdRef.current !== nextTurnId) {
        prevTurnIdRef.current = nextTurnId
        setFilter('all')
        setOpenStepIds(focusedCallId ? new Set([focusedCallId]) : new Set())
        setSelectedCallId(focusedCallId)
        setScrollTarget(focusedCallId ? { callId: focusedCallId, nonce: focusNonce } : null)
      }
    }, [turn?.messageId, focusedCallId, focusNonce])

    useEffect(() => {
      if (!focusedCallId) {
        return
      }
      setFilter('all')
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

    const activeFilter: ActivityFilter =
      filter === 'visuals' && (timeline?.visuals.length ?? 0) === 0
        ? 'all'
        : filter === 'errors' && (timeline?.errorCount ?? 0) === 0
          ? 'all'
          : filter

    useEffect(() => {
      if (!scrollTarget || effectiveTab !== 'activity' || activeFilter !== 'all') {
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
    }, [scrollTarget, effectiveTab, activeFilter, turn?.messageId])

    const toggleStep = useCallback((callId: string) => {
      setSelectedCallId(callId)
      setOpenStepIds((prev) => {
        const next = new Set(prev)
        if (next.has(callId)) {
          next.delete(callId)
        } else {
          next.add(callId)
        }
        return next
      })
    }, [])

    const inspectStepFromStoryboard = useCallback((callId: string) => {
      setFilter('all')
      setSelectedCallId(callId)
      setOpenStepIds((prev) => {
        const next = new Set(prev)
        next.add(callId)
        return next
      })
      localScrollNonceRef.current += 1
      setScrollTarget({ callId, nonce: -localScrollNonceRef.current })
    }, [])

    const turnOptions = useMemo(
      () =>
        activityTurns.map((item) => ({
          value: item.messageId,
          label: item.promptExcerpt
            ? t('turnOptionWithPrompt', { number: item.turnNumber, prompt: item.promptExcerpt })
            : t('turnOptionLabel', { number: item.turnNumber }),
        })),
      [activityTurns, t]
    )

    const isPinnedBehindLatest = Boolean(
      sessionId &&
      activeSelection?.kind === 'pinned' &&
      latestTurnId &&
      latestTurnId !== resolvedMessageId
    )

    const expandableIds = useMemo(
      () => (timeline ? allExpandableCallIds(timeline) : []),
      [timeline]
    )
    const openCount = useMemo(
      () => expandableIds.filter((id) => openStepIds.has(id)).length,
      [expandableIds, openStepIds]
    )
    const canExpandAll =
      activeFilter === 'all' &&
      expandableIds.length >= 2 &&
      expandableIds.length <= MAX_EXPAND_ALL_STEPS &&
      openCount < expandableIds.length
    const canCollapseAll = activeFilter === 'all' && openCount >= 2

    const hasSecondaryFilters = Boolean(
      timeline && (timeline.visuals.length > 0 || timeline.errorCount > 0)
    )
    const showFilterToolbar = Boolean(
      turn &&
      timeline &&
      effectiveTab === 'activity' &&
      (hasSecondaryFilters ||
        (timeline.stepCount >= STAGED_FILTER_MIN_STEPS && (canExpandAll || canCollapseAll)) ||
        canCollapseAll)
    )

    const showContextRow = Boolean(
      turn &&
      timeline &&
      effectiveTab === 'activity' &&
      (turnOptions.length >= 2 || timeline.tallyLabel || isPinnedBehindLatest)
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
      if (timeline.phases.length === 0 && timeline.thinkingBlocks.length === 0) {
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
      if (activeFilter === 'visuals') {
        return (
          <VisualStoryboard
            visuals={timeline.visuals}
            onInspectStep={inspectStepFromStoryboard}
            onOpenLink={openLink}
          />
        )
      }
      if (activeFilter === 'errors') {
        const failedRows: { phase: ActivityLanePhase; item: ActivityStepRecord }[] = []
        for (const phase of timeline.phases) {
          if (phase.type === 'lane') {
            for (const item of phase.items) {
              if (item.status === 'error') {
                failedRows.push({ phase, item })
              }
            }
          }
        }
        return (
          <HoverGlide className={styles.stream}>
            {failedRows.map(({ phase, item }) => {
              const capState = phase.capabilityId
                ? turn.capabilityState?.[phase.capabilityId]
                : undefined
              return (
                <ActivityStepRow
                  key={item.callId}
                  item={item}
                  phase={phase}
                  sessionId={turn.sessionId}
                  streaming={live}
                  now={now}
                  capabilityState={capState}
                  open
                  selected={selectedCallId === item.callId}
                  onToggle={() => toggleStep(item.callId)}
                  openLink={openLink}
                  openFile={deps.openFile}
                  renderMarkdown={renderMarkdown}
                />
              )
            })}
          </HoverGlide>
        )
      }

      const hasPinnedReasoning = timeline.thinkingBlocks.length > 0

      return (
        <HoverGlide className={styles.stream}>
          {hasPinnedReasoning ? (
            <ReasoningSection
              key={`${turn.messageId}-reasoning`}
              messageId={turn.messageId}
              markdown={timeline.thinkingBlocks.map((b) => b.thinking).join('\n\n')}
              seconds={timeline.thinkingSeconds}
              defaultOpen={timeline.thinkingOnly}
              loading={
                live &&
                timeline.thinkingBlocks.at(-1)?.startedAt !== undefined &&
                timeline.thinkingBlocks.at(-1)?.endedAt === undefined
              }
            />
          ) : null}

          {timeline.phases.map((phase, index) => {
            const hasPreviousContent = hasPinnedReasoning || index > 0
            if (phase.type === 'preamble') {
              return (
                <PreambleBeat
                  key={phase.key}
                  cacheKey={`${turn.messageId}-${phase.key}`}
                  markdown={phase.markdown}
                  hasPreviousContent={hasPreviousContent}
                />
              )
            }
            if (phase.type === 'server_search') {
              return (
                <ServerSearchRow
                  key={phase.key}
                  queries={phase.queries}
                  pages={phase.pages}
                  openLink={openLink}
                />
              )
            }
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
                    now={now}
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
              <div key={phase.key} className={clsx(styles.stepGroup, laneShift && styles.beatGap)}>
                {phase.items.map((item) => (
                  <ActivityStepRow
                    key={item.callId}
                    item={item}
                    phase={phase}
                    sessionId={turn.sessionId}
                    streaming={live}
                    now={now}
                    capabilityState={capState}
                    open={openStepIds.has(item.callId)}
                    selected={selectedCallId === item.callId}
                    onToggle={() => toggleStep(item.callId)}
                    openLink={openLink}
                    openFile={deps.openFile}
                    renderMarkdown={renderMarkdown}
                  />
                ))}
              </div>
            )
          })}
        </HoverGlide>
      )
    }

    const contextBars = (
      <>
        {showContextRow ? (
          <div className={styles.contextBar}>
            <div className={styles.contextMain}>
              {sessionId && turnOptions.length >= 2 && resolvedMessageId ? (
                <Select
                  ariaLabel={t('turnSelectorLabel')}
                  value={resolvedMessageId}
                  options={turnOptions}
                  className={styles.turnSelect}
                  onChange={(nextMessageId) => state.selectTurn(sessionId, nextMessageId)}
                />
              ) : timeline?.tallyLabel ? (
                <div className={styles.turnTally}>{timeline.tallyLabel}</div>
              ) : null}
            </div>
            {isPinnedBehindLatest && sessionId ? (
              <Button
                variant="ghost"
                size="s"
                className={styles.followButton}
                onClick={() => state.followLatest(sessionId)}
              >
                {t('followLatest')}
              </Button>
            ) : null}
          </div>
        ) : null}

        {showFilterToolbar && timeline ? (
          <div className={styles.filterBar}>
            {hasSecondaryFilters ? (
              <div className={styles.filterChips}>
                <Chip
                  ghost
                  active={activeFilter === 'all'}
                  aria-pressed={activeFilter === 'all'}
                  className={styles.filterChip}
                  onClick={() => setFilter('all')}
                >
                  <span>{t('filterAll')}</span>
                  <span className={styles.chipCount}>{timeline.stepCount}</span>
                </Chip>
                {timeline.visuals.length > 0 ? (
                  <Chip
                    ghost
                    active={activeFilter === 'visuals'}
                    aria-pressed={activeFilter === 'visuals'}
                    icon={<IconPhotoOutline14 />}
                    className={styles.filterChip}
                    onClick={() => setFilter('visuals')}
                  >
                    <span>{t('filterVisuals')}</span>
                    <span className={styles.chipCount}>{timeline.visuals.length}</span>
                  </Chip>
                ) : null}
                {timeline.errorCount > 0 ? (
                  <Chip
                    ghost
                    active={activeFilter === 'errors'}
                    aria-pressed={activeFilter === 'errors'}
                    icon={<IconWarningOutline16 />}
                    className={clsx(styles.filterChip, styles.errorFilterChip)}
                    onClick={() => setFilter('errors')}
                  >
                    <span>{t('filterErrors')}</span>
                    <span className={styles.chipCount}>{timeline.errorCount}</span>
                  </Chip>
                ) : null}
              </div>
            ) : (
              <span />
            )}

            {canCollapseAll ? (
              <Button
                variant="ghost"
                size="s"
                className={styles.bulkAction}
                onClick={() => setOpenStepIds(new Set())}
              >
                {t('collapseAll')}
              </Button>
            ) : canExpandAll ? (
              <Button
                variant="ghost"
                size="s"
                className={styles.bulkAction}
                onClick={() => setOpenStepIds(new Set(expandableIds))}
              >
                {t('expandAll')}
              </Button>
            ) : null}
          </div>
        ) : null}
      </>
    )

    const liveBadge = live ? (
      <span className={styles.liveBadge} role="status" aria-live="polite">
        <span className={styles.liveDot} aria-hidden="true" />
        <span>{t('liveStatus')}</span>
      </span>
    ) : null

    const closeButton = (
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
    )

    if (hasSources && timeline) {
      return (
        <Tabs value={effectiveTab} onChange={state.setTab}>
          <div className={styles.header} data-tauri-drag-region>
            <div className={styles.headerLeading}>
              <TabList ariaLabel={t('panelTitle')} className={styles.tabList}>
                <Tab value="activity" className={styles.tab}>
                  {t('tabSteps')}
                </Tab>
                <Tab
                  value="sources"
                  className={styles.tab}
                  badge={<span className={styles.tabCount}>{timeline.sources.all.length}</span>}
                >
                  {t('tabSources')}
                </Tab>
              </TabList>
              {liveBadge}
            </div>
            {closeButton}
          </div>

          {contextBars}

          <TabPanel value="activity" className={styles.tabPanel}>
            <div ref={contentRef} className={styles.content}>
              {renderActivityBody()}
            </div>
          </TabPanel>
          <TabPanel value="sources" className={styles.tabPanel}>
            <div className={styles.content}>
              <SourcesView
                cited={timeline.sources.cited}
                other={timeline.sources.other}
                all={timeline.sources.all}
                onOpenLink={openLink}
              />
            </div>
          </TabPanel>
        </Tabs>
      )
    }

    return (
      <>
        <div className={styles.header} data-tauri-drag-region>
          <div className={styles.headerLeading} data-tauri-drag-region>
            <div role="heading" aria-level={2} className={styles.title} data-tauri-drag-region>
              {t('panelTitle')}
            </div>
            {liveBadge}
          </div>
          {closeButton}
        </div>

        {contextBars}

        <div ref={contentRef} className={styles.content}>
          {renderActivityBody()}
        </div>
      </>
    )
  }

  return ActivityPanel
}
