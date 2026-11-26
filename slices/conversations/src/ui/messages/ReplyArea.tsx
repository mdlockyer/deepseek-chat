import type { DeliveredFileRef, LiveTrack } from '@deepseek-chat/lib-tools'
import {
  Button,
  HoverGlide,
  IconCheckedOutline14,
  IconChevronRightOutline14,
  hoverGlideItem,
} from '@deepseek-chat/lib-ui'
import clsx from 'clsx'
import { memo, useEffect, useLayoutEffect, useRef, useState } from 'react'
import { formatSize, getExtension } from '../../attachments.js'
import { useConversations } from '../../context.js'
import { useTranslate } from '../../messages.js'
import type { AssistantMessage } from '../../types.js'
import type { ReplyView } from '../../view.js'
import {
  INLINE_TRACE_PREVIEW_LIMIT,
  buildInlineTrace,
  buildTurnWorkStrip,
  getFrontStageNotes,
  selectInlineTracePreview,
  type FrontStageNoteEntry,
  type InlineTrace,
} from '../../workStrip.js'
import { FileCard } from '../files/FileCard.js'
import { ChatMarkdown as Markdown } from './ChatMarkdown.js'
import styles from './ReplyArea.module.css'
import { Reveal } from './Reveal.js'
import './thinking.markdown.css'
import { WhaleLoader } from './WhaleLoader.js'

const useNoInspection = () => null
const useNotShown = () => false

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

/**
 * Front Stage Turn Work Strip (Tier 0 -> Tier 1 -> Tier 2 progressive disclosure):
 * - Tier 0: bounded live ticker while working, folding to a quiet summary row once settled.
 * - Tier 1: clicking the row / chevron expands a compact inline step trace (or thinking prose
 *   on thinking-only turns) in place without displacing the right-hand workspace panel.
 * - Tier 2: an explicit "Open in Activity" control inside the expanded trace publishes
 *   `TurnInspectionRequested` to inspect heavy artifacts (code, screenshots, sources, reasoning)
 *   side by side in the Activity panel.
 */
export const ReplyArea = memo(function ReplyArea({
  sessionId,
  message,
  view,
  streaming,
  compacting = false,
  stalled,
  hasResponse,
}: {
  sessionId: string
  message: AssistantMessage
  view: ReplyView
  streaming: boolean
  compacting?: boolean
  stalled: boolean
  hasResponse: boolean
}) {
  const t = useTranslate()
  const { deps, requestTurnInspection } = useConversations()
  const useActiveInspection = deps.ui.useActiveInspectionTarget ?? useNoInspection
  const target = useActiveInspection()
  const isInspecting =
    target !== null &&
    target.sessionId === sessionId &&
    target.messageId === message.id &&
    target.tab === 'activity'
  const [expanded, setExpanded] = useState(false)

  const tick = useTicker(streaming, 1000)
  const strip = buildTurnWorkStrip(
    message,
    view,
    streaming,
    Date.now() + tick * 0,
    stalled,
    hasResponse,
    compacting
  )
  const notes = getFrontStageNotes(view)

  if (strip.mode === 'hidden' && notes.length === 0) {
    return null
  }

  const toggleExpanded = () => setExpanded((value) => !value)
  const inspectActivity = (callId?: string) =>
    requestTurnInspection(sessionId, message.id, 'activity', callId)

  const trackStatusLabel = (track: LiveTrack): string | null => {
    if (track.status === 'running') {
      return track.detail ? null : t('activityTrackRunning')
    }
    if (track.status === 'finished') {
      return t('activityTrackFinished')
    }
    if (track.status === 'exhausted') {
      return t('activityTrackExhausted')
    }
    if (track.status === 'failed') {
      return t('activityTrackFailed')
    }
    return t('activityTrackStopped')
  }

  return (
    <div className={styles.area}>
      {strip.mode === 'waiting' ? (
        <div className={styles.waiting} role="status" aria-live="polite">
          <span className={styles.iconSlot}>
            <WhaleLoader width={16} />
          </span>
          <span className={styles.headline}>{strip.label}</span>
        </div>
      ) : strip.mode === 'live' ? (
        <div className={styles.liveWrap}>
          <button
            type="button"
            className={clsx(styles.stripButton, expanded && styles.stripButtonActive)}
            aria-expanded={expanded}
            aria-label={t('activityToggleTraceLabel')}
            onClick={toggleExpanded}
          >
            <span className={clsx(styles.iconSlot, strip.waitingForUser && styles.waitingIcon)}>
              <WhaleLoader width={strip.waitingForUser ? 15 : 16} still={strip.waitingForUser} />
            </span>
            <span className={styles.headline}>{strip.headline}</span>
            <span
              className={clsx(styles.chevron, expanded && styles.chevronOpen)}
              aria-hidden="true"
            >
              <IconChevronRightOutline14 />
            </span>
          </button>

          <Reveal open={expanded}>
            {() => {
              const trace = buildInlineTrace(view)
              return (
                <InlineTraceInlay
                  messageId={message.id}
                  trace={trace}
                  streaming={streaming}
                  thinkingOnly={trace.items.length === 0 && trace.thinkingMarkdown !== null}
                  isInspecting={isInspecting}
                  onInspect={inspectActivity}
                />
              )
            }}
          </Reveal>

          {expanded ? null : strip.liveTracks.length > 0 ? (
            <div className={styles.liveTracks} role="status" aria-live="polite">
              {strip.liveTracks.map((track) => {
                const isRunning = track.status === 'running'
                const isFailed = track.status === 'failed'
                const isSettled = !isRunning && !isFailed
                const showDetail = (isRunning || isFailed) && Boolean(track.detail)
                const statusText = trackStatusLabel(track)
                return (
                  <button
                    key={track.id}
                    type="button"
                    className={clsx(
                      styles.liveTrackRow,
                      isSettled && styles.liveTrackSettled,
                      isFailed && styles.liveTrackFailed
                    )}
                    onClick={toggleExpanded}
                  >
                    <span className={styles.liveTrackMain}>
                      <span className={styles.liveTrackLabel}>{track.label}</span>
                      {showDetail ? (
                        <span className={styles.liveTrackDetail}>{track.detail}</span>
                      ) : null}
                    </span>
                    {statusText ? (
                      <span
                        className={clsx(
                          styles.liveTrackStatus,
                          isFailed && styles.liveTrackStatusError
                        )}
                      >
                        {statusText}
                      </span>
                    ) : null}
                  </button>
                )
              })}
              {strip.overflowTracks > 0 ? (
                <button
                  type="button"
                  className={styles.liveTrackOverflow}
                  onClick={() => inspectActivity()}
                >
                  {t('activityMoreTracks', { count: strip.overflowTracks })}
                </button>
              ) : null}
            </div>
          ) : strip.detail ? (
            <div className={styles.liveDetailRail} role="status" aria-live="polite">
              <button type="button" className={styles.liveDetail} onClick={toggleExpanded}>
                {strip.detail}
              </button>
            </div>
          ) : null}
        </div>
      ) : strip.mode === 'settled' ? (
        <div className={styles.liveWrap}>
          <button
            type="button"
            className={clsx(
              styles.stripButton,
              styles.settledButton,
              expanded && styles.stripButtonActive
            )}
            aria-expanded={expanded}
            onClick={toggleExpanded}
          >
            <span className={clsx(styles.iconSlot, strip.stopped && styles.stoppedIcon)}>
              <WhaleLoader width={15} still />
            </span>
            <span className={styles.settledLabel}>{strip.label}</span>
            <span
              className={clsx(styles.chevron, expanded && styles.chevronOpen)}
              aria-hidden="true"
            >
              <IconChevronRightOutline14 />
            </span>
          </button>

          <Reveal open={expanded}>
            {() => (
              <InlineTraceInlay
                messageId={message.id}
                trace={buildInlineTrace(view)}
                streaming={false}
                thinkingOnly={strip.thinkingOnly}
                isInspecting={isInspecting}
                onInspect={inspectActivity}
              />
            )}
          </Reveal>
        </div>
      ) : null}

      {notes.length > 0 ? <FrontStageNotes notes={notes} /> : null}
    </div>
  )
})

const findScrollParent = (el: HTMLElement): HTMLElement | null => {
  for (let node = el.parentElement; node; node = node.parentElement) {
    const { overflowY } = getComputedStyle(node)
    if ((overflowY === 'auto' || overflowY === 'scroll') && node.scrollHeight > node.clientHeight) {
      return node
    }
  }
  return null
}

const InlineTraceInlay = ({
  messageId,
  trace,
  streaming,
  thinkingOnly,
  isInspecting,
  onInspect,
}: {
  messageId: string
  trace: InlineTrace
  streaming: boolean
  thinkingOnly: boolean
  isInspecting: boolean
  onInspect: (callId?: string) => void
}) => {
  const t = useTranslate()
  const [showAll, setShowAll] = useState(false)
  const toggleMoreRef = useRef<HTMLButtonElement | null>(null)
  const collapseAnchorRef = useRef<{ scrollEl: HTMLElement; top: number } | null>(null)

  useLayoutEffect(() => {
    const anchor = collapseAnchorRef.current
    if (!anchor) {
      return
    }
    collapseAnchorRef.current = null
    const button = toggleMoreRef.current
    if (!button) {
      return
    }
    const delta = button.getBoundingClientRect().top - anchor.top
    if (delta !== 0) {
      anchor.scrollEl.scrollTop += delta
    }
  }, [showAll])

  const collapseSteps = () => {
    const button = toggleMoreRef.current
    const scrollEl = button ? findScrollParent(button) : null
    if (button && scrollEl) {
      collapseAnchorRef.current = { scrollEl, top: button.getBoundingClientRect().top }
    }
    setShowAll(false)
  }

  const preview = showAll
    ? {
        entries: trace.items.map((item) => ({ item, gapBefore: false })),
        hiddenCount: 0,
      }
    : selectInlineTracePreview(trace.items)
  const canCollapseList = showAll && trace.items.length > INLINE_TRACE_PREVIEW_LIMIT
  const showFooter = preview.hiddenCount > 0 || canCollapseList || trace.hasRichDetails
  const hasIcons = preview.entries.some(({ item }) => item.icon !== undefined && item.icon !== null)

  return (
    <HoverGlide className={styles.inlineTrace}>
      {thinkingOnly && trace.thinkingMarkdown ? (
        <div className={clsx(styles.inlineThinking, 'ds-think-content')}>
          <Markdown
            content={trace.thinkingMarkdown}
            loading={streaming}
            cacheKey={`${messageId}-inline-think`}
            disableLink={false}
          />
        </div>
      ) : trace.items.length > 0 ? (
        <ul className={styles.traceList}>
          {preview.entries.map(({ item, gapBefore }, index) => {
            const prevLane = index > 0 ? preview.entries[index - 1].item.lane : undefined
            const laneBreak =
              !gapBefore &&
              index > 0 &&
              Boolean(item.lane) &&
              Boolean(prevLane) &&
              item.lane !== prevLane
            return (
              <li
                key={item.key}
                className={clsx(
                  styles.traceItem,
                  gapBefore && styles.traceItemGap,
                  laneBreak && styles.traceItemLaneBreak,
                  item.status === 'running' && styles.traceItemRunning
                )}
              >
                <button
                  type="button"
                  className={styles.traceRowButton}
                  title={item.label}
                  {...hoverGlideItem()}
                  onClick={() => onInspect(item.callId)}
                >
                  <span className={styles.traceRow}>
                    {hasIcons ? (
                      <span
                        className={clsx(
                          styles.traceIcon,
                          item.status === 'failed' && styles.traceIconError
                        )}
                        aria-hidden="true"
                      >
                        {item.icon}
                      </span>
                    ) : null}
                    <span
                      className={clsx(
                        styles.traceLabel,
                        item.status === 'running' && styles.traceLabelActive
                      )}
                    >
                      {item.label}
                    </span>
                    {item.status === 'failed' ? (
                      <span className={styles.srOnly}> ({t('activityTrackFailed')})</span>
                    ) : null}
                    {item.status === 'running' ? (
                      <span className={styles.traceRunningTag}>{t('activityTrackRunning')}</span>
                    ) : null}
                  </span>
                </button>
              </li>
            )
          })}
        </ul>
      ) : trace.thinkingMarkdown ? (
        <div className={clsx(styles.inlineThinking, 'ds-think-content')}>
          <Markdown
            content={trace.thinkingMarkdown}
            loading={streaming}
            cacheKey={`${messageId}-inline-think`}
            disableLink={false}
          />
        </div>
      ) : null}

      {showFooter ? (
        <div className={styles.traceFooter}>
          {preview.hiddenCount > 0 ? (
            <Button
              ref={toggleMoreRef}
              variant="ghost"
              size="s"
              className={styles.traceFooterAction}
              {...hoverGlideItem()}
              onClick={() => setShowAll(true)}
            >
              {t(
                preview.hiddenCount === 1
                  ? 'activityShowMoreStepsOne'
                  : 'activityShowMoreStepsMany',
                { count: preview.hiddenCount }
              )}
            </Button>
          ) : canCollapseList ? (
            <Button
              ref={toggleMoreRef}
              variant="ghost"
              size="s"
              className={styles.traceFooterAction}
              {...hoverGlideItem()}
              onClick={collapseSteps}
            >
              {t('activityShowFewerSteps')}
            </Button>
          ) : null}
          {trace.hasRichDetails ? (
            <Button
              variant="ghost"
              size="s"
              trailingIcon={<IconChevronRightOutline14 />}
              className={clsx(styles.traceFooterAction, isInspecting && styles.inspectButtonActive)}
              aria-pressed={isInspecting}
              {...hoverGlideItem(isInspecting)}
              onClick={() => onInspect()}
            >
              {isInspecting ? t('activityViewingInPanel') : t('activityOpenInPanel')}
            </Button>
          ) : null}
        </div>
      ) : null}
    </HoverGlide>
  )
}

const FrontStageNotes = ({ notes }: { notes: readonly FrontStageNoteEntry[] }) => {
  const t = useTranslate()
  return (
    <div className={styles.frontAsks}>
      {notes.map(({ key, note }) => {
        if (note.status === 'skipped') {
          return (
            <div key={key} className={styles.frontAskRow}>
              <IconCheckedOutline14 />
              <span>{t('noteSkipped')}</span>
            </div>
          )
        }
        const answered = note.items.filter((item) =>
          Array.isArray(item.value) ? item.value.length > 0 : Boolean(item.value)
        )
        if (answered.length === 0) {
          return null
        }
        return (
          <div key={key} className={styles.frontAskRow}>
            {answered.map((item) => (
              <span key={item.id} className={styles.askEntry}>
                <span className={styles.askEntryKey}>{item.label}:</span>
                <span className={styles.askEntryVal}>
                  {Array.isArray(item.value) ? item.value.join(', ') : item.value}
                </span>
              </span>
            ))}
          </div>
        )
      })}
    </div>
  )
}

/** 统一的可预览与下载文件卡片：点击在右侧文件面板预览（未挂载预览切片时直接保存），右侧按钮可直接保存 */
export const DeliveredFileCard = ({
  sessionId,
  file,
}: {
  sessionId: string
  file: DeliveredFileRef
}) => {
  const t = useTranslate()
  const { blobs, deps } = useConversations()
  const [missing, setMissing] = useState(false)
  const shownFile = { kind: 'delivered', file } as const
  const useIsFileShown = deps.ui.useIsFileShown ?? useNotShown
  const isOpen = useIsFileShown(sessionId, shownFile)

  const downloadStoredFile = async (): Promise<boolean> => {
    const blob = await blobs.get(file.id)
    if (!blob) {
      return false
    }
    await deps.ui.saveFile(file.name, blob)
    return true
  }

  const triggerDownload = () => {
    void downloadStoredFile().then(
      (ok) => setMissing(!ok),
      () => setMissing(true)
    )
  }

  const ext = getExtension(file.name)
  const versionTag = file.version !== undefined && file.version > 1 ? `v${file.version}` : undefined
  const subtitle = [ext, formatSize(file.size), versionTag].filter(Boolean).join(' · ')

  return (
    <FileCard
      name={file.name}
      title={file.title}
      size={file.size}
      subtitle={missing ? t('fileUnavailable') : subtitle}
      status={missing ? 'error' : 'done'}
      error={missing ? t('fileUnavailable') : undefined}
      active={isOpen}
      onOpen={deps.ui.openFile ? () => deps.ui.openFile?.(sessionId, shownFile) : triggerDownload}
      onDownload={triggerDownload}
    />
  )
}
