import { Markdown } from '@deepseek-chat/lib-markdown'
import type { ToolStepVisualArtifact } from '@deepseek-chat/lib-tools'
import {
  EmptyState,
  HoverGlide,
  IconActivityOutline16,
  IconChevronDownOutline14,
  IconChevronRightOutline14,
  IconChevronUpOutline14,
  IconCloseOutline16,
  IconCodeOutline14,
  IconPhotoOutline14,
  IconThinkOutline16,
  IconButton,
  PanelTitleMenu,
  hoverGlideItem,
} from '@deepseek-chat/lib-ui'
import { useLocale, type Locale } from '@deepseek-chat/spine/i18n'
import clsx from 'clsx'
import {
  memo,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  useSyncExternalStore,
  type MouseEvent,
  type ReactNode,
} from 'react'
import { escapeAttr, useChapterScroller } from './chapterScroller.js'
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
import { VisualLightbox } from './VisualLightbox.js'
import styles from './ActivityPanel.module.css'

const EMPTY_VISUALS: readonly ActivityVisualItem[] = []

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

/** One turn of the chat in the panel: its summary and its live snapshot. */
type Chapter = { readonly summary: SessionTurnSummary; readonly turn: TurnSnapshot | null }

type LightboxState = {
  readonly messageId: string
  readonly index: number
  readonly fallback?: ActivityVisualItem
}

const NO_CHAPTERS: readonly Chapter[] = []

const sameSummary = (a: SessionTurnSummary, b: SessionTurnSummary) =>
  a.messageId === b.messageId &&
  a.turnNumber === b.turnNumber &&
  a.promptExcerpt === b.promptExcerpt &&
  a.streaming === b.streaming &&
  a.hasActivity === b.hasActivity

const sameTurn = (a: TurnSnapshot | null, b: TurnSnapshot | null) =>
  a === b ||
  (a !== null &&
    b !== null &&
    a.sessionId === b.sessionId &&
    a.messageId === b.messageId &&
    a.status === b.status &&
    a.streaming === b.streaming &&
    a.blocks === b.blocks &&
    a.capabilityState === b.capabilityState)

export const createActivityPanel = (
  state: ActivityPanelState,
  deps: ActivityInspectorDeps,
  resolveMessageId: (selection: ActivitySelection) => string | null
) => {
  const timelinesByLocale = new Map<Locale, WeakMap<TurnSnapshot, ActivityTimeline>>()
  const timelineFor = (turn: TurnSnapshot, locale: Locale): ActivityTimeline => {
    let bucket = timelinesByLocale.get(locale)
    if (!bucket) {
      bucket = new WeakMap<TurnSnapshot, ActivityTimeline>()
      timelinesByLocale.set(locale, bucket)
    }
    let timeline = bucket.get(turn)
    if (!timeline) {
      timeline = buildActivityTimeline(turn, deps.getPresenter, undefined, locale)
      bucket.set(turn, timeline)
    }
    return timeline
  }

  const renderMarkdown = ({
    content,
    cacheKey,
  }: {
    readonly content: string
    readonly cacheKey: string
  }) => <Markdown content={content} loading={false} cacheKey={cacheKey} disableLink={false} />

  const openLink = (event: MouseEvent, url: string) => {
    if (deps.openInApp && /^https?:\/\//i.test(url)) {
      event.preventDefault()
      deps.openInApp(url)
    }
  }

  const subscribeAll = (listener: () => void) => {
    const unsubTurns = deps.turnSource.subscribe(listener)
    const unsubReading = deps.transcript?.subscribeToReading(listener)
    return () => {
      unsubTurns()
      unsubReading?.()
    }
  }

  /** A turn's sticky header: its number, its prompt, and a live marker or a quiet summary. */
  const ChapterHeading = ({
    chapter,
    number,
    current,
    meta,
    onSelect,
  }: {
    chapter: Chapter
    number: number
    current: boolean
    meta: string | null
    onSelect: () => void
  }) => {
    const t = activityInspectorMessages.useTranslate()
    const live = chapter.summary.streaming
    const title = chapter.summary.promptExcerpt || t('turnShortLabel', { number })
    return (
      <h3 className={styles.chapterHeading}>
        <button
          type="button"
          className={styles.chapterHeader}
          aria-label={t('chapterLabel', { number, prompt: title })}
          aria-current={current ? 'true' : undefined}
          onClick={onSelect}
        >
          <span className={styles.chapterNumber} aria-hidden="true">
            {number}
          </span>
          <span className={styles.chapterTitle} aria-hidden="true">
            {title}
          </span>
          {live ? (
            <span className={styles.chapterLive} aria-hidden="true">
              <span className={styles.liveDot} />
              {t('liveStatus')}
            </span>
          ) : meta ? (
            <span className={styles.chapterMeta} aria-hidden="true">
              {meta}
            </span>
          ) : null}
        </button>
      </h3>
    )
  }

  const chapterMeta = (
    t: ReturnType<typeof activityInspectorMessages.useTranslate>,
    timeline: ActivityTimeline | null
  ): string | null => {
    if (!timeline) {
      return null
    }
    if (timeline.stepCount > 0) {
      return timeline.stepCount === 1
        ? t('chapterStepsOne')
        : t('chapterStepsMany', { count: timeline.stepCount })
    }
    return timeline.thinkingSeconds !== null
      ? t('reasoningSeconds', { seconds: timeline.thinkingSeconds })
      : null
  }

  /** One turn's activity: reasoning, outputs and steps, with its own expanded and selected steps. */
  const TurnChapter = memo(function TurnChapter({
    chapter,
    number,
    current,
    focusedCallId,
    focusNonce,
    onSelect,
    onOpenVisual,
    revealElement,
  }: {
    chapter: Chapter
    number: number
    current: boolean
    focusedCallId: string | null
    focusNonce: number
    onSelect: (messageId: string) => void
    onOpenVisual: (messageId: string, index: number, fallback?: ActivityVisualItem) => void
    revealElement: (node: HTMLElement) => void
  }) {
    const locale = useLocale()
    const t = activityInspectorMessages.useTranslate()
    const { summary, turn } = chapter
    const timeline = turn ? timelineFor(turn, locale) : null
    const live = Boolean(turn && turn.streaming && turn.status === 'streaming')
    const bodyRef = useRef<HTMLDivElement>(null)
    const [openStepIds, setOpenStepIds] = useState<ReadonlySet<string>>(() =>
      focusedCallId ? new Set([focusedCallId]) : new Set()
    )
    const [selectedCallId, setSelectedCallId] = useState<string | null>(focusedCallId)

    useEffect(() => {
      if (!focusedCallId) {
        return
      }
      setSelectedCallId(focusedCallId)
      setOpenStepIds((prev) => (prev.has(focusedCallId) ? prev : new Set(prev).add(focusedCallId)))
      const frame = requestAnimationFrame(() => {
        const node = bodyRef.current?.querySelector<HTMLElement>(
          `[data-activity-call-id="${escapeAttr(focusedCallId)}"]`
        )
        if (node) {
          revealElement(node)
        }
      })
      return () => cancelAnimationFrame(frame)
    }, [focusedCallId, focusNonce, revealElement])

    const toggleStep = (callId: string) => {
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
      setSelectedCallId((value) => (closing ? (value === callId ? null : value) : callId))
    }

    const inspectStep = (callId: string) => {
      if (turn) {
        state.toggleTurn(turn.sessionId, summary.messageId, 'activity', callId)
      }
    }

    const visuals = timeline?.visuals ?? EMPTY_VISUALS
    const openVisualForStep = (
      callId: string,
      stepLabel: string,
      visual: ToolStepVisualArtifact
    ) => {
      const exact = visuals.findIndex((item) => item.callId === callId && item.src === visual.src)
      const bySrc = exact >= 0 ? exact : visuals.findIndex((item) => item.src === visual.src)
      if (bySrc >= 0) {
        onOpenVisual(summary.messageId, bySrc)
        return
      }
      onOpenVisual(summary.messageId, 0, {
        key: `${callId}-fallback`,
        callId,
        stepLabel,
        src: visual.src,
        alt: visual.alt,
        ...(visual.caption ? { caption: visual.caption } : {}),
        ...(visual.href ? { href: visual.href } : {}),
      })
    }

    const renderBody = () => {
      if (
        !turn ||
        !timeline ||
        (timeline.phases.length === 0 && timeline.thinkingRounds.length === 0)
      ) {
        return <p className={styles.chapterEmpty}>{t('chapterNoActivity')}</p>
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
            onOpenVisual={(index) => onOpenVisual(summary.messageId, index)}
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

    return (
      <section
        className={clsx(styles.chapter, current && styles.chapterCurrent)}
        data-chapter-id={summary.messageId}
      >
        <ChapterHeading
          chapter={chapter}
          number={number}
          current={current}
          meta={chapterMeta(t, timeline)}
          onSelect={() => onSelect(summary.messageId)}
        />
        <div ref={bodyRef} className={styles.chapterBody}>
          {renderBody()}
        </div>
      </section>
    )
  })

  /** One turn's sources: cited first, then the rest. */
  const SourcesChapter = memo(function SourcesChapter({
    chapter,
    number,
    current,
    onSelect,
  }: {
    chapter: Chapter
    number: number
    current: boolean
    onSelect: (messageId: string) => void
  }) {
    const locale = useLocale()
    const t = activityInspectorMessages.useTranslate()
    const timeline = chapter.turn ? timelineFor(chapter.turn, locale) : null
    if (!timeline) {
      return null
    }
    const count = timeline.sources.all.length
    return (
      <section
        className={clsx(styles.chapter, current && styles.chapterCurrent)}
        data-chapter-id={chapter.summary.messageId}
      >
        <ChapterHeading
          chapter={chapter}
          number={number}
          current={current}
          meta={count === 1 ? t('chapterSourcesOne') : t('chapterSourcesMany', { count })}
          onSelect={() => onSelect(chapter.summary.messageId)}
        />
        <div className={styles.chapterBody}>
          <SourcesView
            cited={timeline.sources.cited}
            other={timeline.sources.other}
            all={timeline.sources.all}
            onOpenLink={openLink}
          />
        </div>
      </section>
    )
  })

  const ActivityPanel = ({ topActions }: { topActions?: ReactNode } = {}) => {
    const locale = useLocale()
    const t = activityInspectorMessages.useTranslate()
    const selection = state.useStore((s) => s.selection)
    const panelOpen = state.useStore((s) => s.panelOpen)
    const layoutSessionId = deps.panel.useLayout((layout) => layout.activeSessionId)
    const lastSelectionRef = useRef<ActivitySelection | null>(selection)
    if (selection) {
      lastSelectionRef.current = selection
    }
    const activeSelection = selection ?? lastSelectionRef.current
    const sessionId = activeSelection?.sessionId ?? layoutSessionId
    const pinned = activeSelection?.kind === 'pinned' ? activeSelection : null
    const pinnedId = pinned?.messageId ?? null

    const chaptersRef = useRef<readonly Chapter[]>(NO_CHAPTERS)
    const getChapters = useCallback((): readonly Chapter[] => {
      if (!sessionId) {
        return NO_CHAPTERS
      }
      const summaries: readonly SessionTurnSummary[] = deps.turnSource.listTurns
        ? deps.turnSource.listTurns(sessionId)
        : pinnedId
          ? [
              {
                messageId: pinnedId,
                turnNumber: 1,
                promptExcerpt: '',
                streaming: false,
                hasActivity: true,
              },
            ]
          : []
      const prev = chaptersRef.current
      let changed = prev.length !== summaries.length
      const next = summaries.map((summary, index): Chapter => {
        const old = prev[index]
        const turn = deps.turnSource.getTurn(sessionId, summary.messageId)
        const keptSummary = old && sameSummary(old.summary, summary) ? old.summary : summary
        const keptTurn = old && sameTurn(old.turn, turn) ? old.turn : turn
        if (old && keptSummary === old.summary && keptTurn === old.turn) {
          return old
        }
        changed = true
        return { summary: keptSummary, turn: keptTurn }
      })
      if (!changed) {
        return prev
      }
      chaptersRef.current = next
      return next
    }, [sessionId, pinnedId])
    const chapters = useSyncExternalStore(subscribeAll, getChapters, getChapters)

    const getDisplayedId = () => (activeSelection ? resolveMessageId(activeSelection) : null)
    const displayedId = useSyncExternalStore(subscribeAll, getDisplayedId, getDisplayedId)
    const displayedIndex = chapters.findIndex(
      (chapter) => chapter.summary.messageId === displayedId
    )
    // The highlight names the turn at the panel's own reading line, which the panel
    // reports as it is first shown and as the reader scrolls it; the transcript does not move. A new
    // pin takes over until the reader scrolls the panel. Letting go of a pin keeps the turn on show,
    // since the panel stays where it is.
    const [readerId, setReaderId] = useState<string | null>(null)
    const [readerBase, setReaderBase] = useState(selection)
    const shownRef = useRef<string | null>(null)
    if (readerBase !== selection) {
      setReaderBase(selection)
      setReaderId(selection?.kind === 'pinned' ? null : shownRef.current)
    }
    const shownId = readerId ?? displayedId
    shownRef.current = shownId
    const shownIndex = chapters.findIndex((chapter) => chapter.summary.messageId === shownId)
    const lastChapter = chapters.at(-1) ?? null

    const sourceChapters = useMemo(
      () =>
        chapters.filter(
          (chapter) =>
            chapter.turn !== null && timelineFor(chapter.turn, locale).sources.all.length > 0
        ),
      [chapters, locale]
    )
    const hasSources = sourceChapters.length > 0
    const effectiveTab = hasSources ? (activeSelection?.tab ?? 'activity') : 'activity'
    const sourcesTargetId = useMemo(() => {
      if (sourceChapters.length === 0) {
        return null
      }
      const before = sourceChapters.filter(
        (chapter) => chapters.indexOf(chapter) <= Math.max(0, displayedIndex)
      )
      return (before.at(-1) ?? sourceChapters[0])?.summary.messageId ?? null
    }, [sourceChapters, chapters, displayedIndex])

    const pin = useCallback(
      (messageId: string) => {
        if (sessionId) {
          state.selectTurn(sessionId, messageId)
        }
      },
      [sessionId]
    )

    const activityRef = useRef<HTMLDivElement | null>(null)
    const sourcesRef = useRef<HTMLDivElement | null>(null)
    const activityScroller = useChapterScroller({
      containerRef: activityRef,
      targetId: displayedId,
      request: pinned,
      lastId: lastChapter?.summary.messageId ?? null,
      live: lastChapter?.summary.streaming ?? false,
      visible: panelOpen && effectiveTab === 'activity',
      onLineChapter: setReaderId,
    })
    const sourcesScroller = useChapterScroller({
      containerRef: sourcesRef,
      targetId: sourcesTargetId,
      request: pinned,
      lastId: sourceChapters.at(-1)?.summary.messageId ?? null,
      live: false,
      visible: panelOpen && effectiveTab === 'sources',
      onLineChapter: setReaderId,
    })
    const revealInActivity = activityScroller.reveal
    const tabScroller = effectiveTab === 'sources' ? sourcesScroller : activityScroller

    const [lightbox, setLightbox] = useState<LightboxState | null>(null)
    const openVisual = useCallback(
      (messageId: string, index: number, fallback?: ActivityVisualItem) =>
        setLightbox({ messageId, index, ...(fallback ? { fallback } : {}) }),
      []
    )
    const lightboxTurn =
      lightbox && chapters.find((chapter) => chapter.summary.messageId === lightbox.messageId)?.turn
    const lightboxVisuals = lightbox?.fallback
      ? [lightbox.fallback]
      : lightboxTurn
        ? timelineFor(lightboxTurn, locale).visuals
        : EMPTY_VISUALS
    const inspectStep = useCallback(
      (callId: string) => {
        if (sessionId && lightbox) {
          state.toggleTurn(sessionId, lightbox.messageId, 'activity', callId)
        }
      },
      [sessionId, lightbox]
    )

    const focusedCallId = pinned?.focusedCallId ?? null
    const focusNonce = pinned?.focusNonce ?? 0
    const total = chapters.length
    // Previous / next move through the panel only; the transcript stays where the reader left it.
    const stepTo = (index: number) => {
      const target = chapters[index]
      if (target && sessionId) {
        state.pinTurn(sessionId, target.summary.messageId)
      }
    }

    // The scroll-to-bottom button floats over the bottom of the panel while the panel is scrolled
    // up, with a pulsing dot while the latest turn streams. It scrolls the panel only, never the
    // transcript. A keyboard user who presses it lands on the last turn's heading, since the button
    // hides (and goes inert) once the panel reaches the bottom.
    const bottomRef = useRef<HTMLButtonElement>(null)
    const canScrollDown = total > 0 && !tabScroller.atBottom
    const latestStreaming = lastChapter?.summary.streaming ?? false
    const scrollToBottom = () => {
      const hadFocus = document.activeElement === bottomRef.current
      tabScroller.toBottom()
      if (hadFocus) {
        const content = effectiveTab === 'sources' ? sourcesRef.current : activityRef.current
        const headings = content?.querySelectorAll<HTMLElement>(`.${styles.chapterHeader}`)
        headings?.[headings.length - 1]?.focus({ preventScroll: true })
      }
    }

    return (
      <div className={styles.root}>
        <header className={styles.header} data-tauri-drag-region="">
          <div className={styles.headerLeading} data-tauri-drag-region="">
            <h2 className={styles.srOnly}>{t('panelTitle')}</h2>
            <PanelTitleMenu
              label={effectiveTab === 'sources' ? t('tabSources') : t('tabSteps')}
              ariaLabel={t('panelTitle')}
              options={
                hasSources
                  ? [
                      {
                        type: 'radio',
                        key: 'activity',
                        label: t('tabSteps'),
                        checked: effectiveTab === 'activity',
                        onSelect: () => state.setTab('activity'),
                      },
                      {
                        type: 'radio',
                        key: 'sources',
                        label: t('tabSources'),
                        detail: String(
                          sourceChapters.reduce(
                            (sum, chapter) =>
                              sum +
                              (chapter.turn
                                ? timelineFor(chapter.turn, locale).sources.all.length
                                : 0),
                            0
                          )
                        ),
                        checked: effectiveTab === 'sources',
                        onSelect: () => state.setTab('sources'),
                      },
                    ]
                  : []
              }
            />
          </div>

          <div className={styles.topActions}>
            {total >= 2 ? (
              <>
                <IconButton
                  size="xs"
                  icon={<IconChevronUpOutline14 />}
                  tooltip={t('previousTurn')}
                  tooltipPlacement="bottom"
                  aria-label={t('previousTurn')}
                  disabled={shownIndex <= 0}
                  onClick={() => stepTo(shownIndex - 1)}
                />
                <IconButton
                  size="xs"
                  icon={<IconChevronDownOutline14 />}
                  tooltip={t('nextTurn')}
                  tooltipPlacement="bottom"
                  aria-label={t('nextTurn')}
                  disabled={shownIndex < 0 || shownIndex >= total - 1}
                  onClick={() => stepTo(shownIndex + 1)}
                />
              </>
            ) : null}
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

        <div className={styles.tabPanel} hidden={effectiveTab !== 'activity'}>
          <div ref={activityRef} className={styles.content}>
            <div className={styles.chapters}>
              {chapters.length === 0 ? (
                <div className={styles.emptyWrap}>
                  <EmptyState
                    compact
                    icon={<IconActivityOutline16 />}
                    title={t('emptyTitle')}
                    description={t('emptySession')}
                  />
                </div>
              ) : (
                chapters.map((chapter, index) => {
                  const isFocused = chapter.summary.messageId === pinnedId
                  return (
                    <TurnChapter
                      key={chapter.summary.messageId}
                      chapter={chapter}
                      number={deps.turnSource.listTurns ? index + 1 : chapter.summary.turnNumber}
                      current={chapter.summary.messageId === shownId}
                      focusedCallId={isFocused ? focusedCallId : null}
                      focusNonce={isFocused ? focusNonce : 0}
                      onSelect={pin}
                      onOpenVisual={openVisual}
                      revealElement={revealInActivity}
                    />
                  )
                })
              )}
            </div>
          </div>
        </div>

        {hasSources ? (
          <div className={styles.tabPanel} hidden={effectiveTab !== 'sources'}>
            <div ref={sourcesRef} className={styles.content}>
              <div className={styles.chapters}>
                {sourceChapters.map((chapter) => (
                  <SourcesChapter
                    key={chapter.summary.messageId}
                    chapter={chapter}
                    number={chapters.indexOf(chapter) + 1}
                    current={chapter.summary.messageId === sourcesTargetId}
                    onSelect={pin}
                  />
                ))}
              </div>
            </div>
          </div>
        ) : null}

        <IconButton
          ref={bottomRef}
          size="sm"
          className={styles.bottomButton}
          data-shown={canScrollDown ? '' : undefined}
          {...(canScrollDown ? {} : { inert: '', 'aria-hidden': true })}
          icon={
            <>
              <IconChevronDownOutline14 />
              {latestStreaming ? <span className={styles.bottomLiveDot} /> : null}
            </>
          }
          tooltip={t('scrollToBottom')}
          tooltipPlacement="top"
          onClick={scrollToBottom}
        />

        <VisualLightbox
          visuals={lightboxVisuals}
          activeIndex={lightbox?.index ?? null}
          onChangeIndex={(nextIndex) =>
            setLightbox((prev) => (prev ? { ...prev, index: nextIndex } : null))
          }
          onClose={() => setLightbox(null)}
          onInspectStep={inspectStep}
          onOpenLink={openLink}
        />
      </div>
    )
  }

  return ActivityPanel
}
