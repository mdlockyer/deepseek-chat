import type { DeliveredFileRef } from '@deepseek-chat/lib-tools'
import {
  IconCheckedOutline14,
  IconChevronRightOutline14,
  IconCloseFill14,
  IconWarningOutline16,
} from '@deepseek-chat/lib-ui'
import clsx from 'clsx'
import { memo, useEffect, useState } from 'react'
import { formatSize, getExtension } from '../../attachments.js'
import { useConversations } from '../../context.js'
import { useTranslate } from '../../messages.js'
import type { AssistantMessage } from '../../types.js'
import type { ReplyView } from '../../view.js'
import {
  buildTurnWorkStrip,
  getFrontStageNotes,
  type FrontStageNoteEntry,
} from '../../workStrip.js'
import { FileCard } from '../files/FileCard.js'
import styles from './ReplyArea.module.css'
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
 * Front Stage Turn Work Strip:
 * - While working: bounded 2-line live ticker (<= 4 compact lines for parallel tracks),
 *   so completed tool calls never accumulate as a wall pushing the user's question off-screen.
 * - Once answered or finished: collapses automatically to a single quiet summary button that
 *   publishes `TurnInspectionRequested` on the Spine EventLog.
 */
export const ReplyArea = memo(function ReplyArea({
  sessionId,
  message,
  view,
  streaming,
  stalled,
  hasResponse,
}: {
  sessionId: string
  message: AssistantMessage
  view: ReplyView
  streaming: boolean
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

  const tick = useTicker(streaming, 1000)
  const strip = buildTurnWorkStrip(
    message,
    view,
    streaming,
    Date.now() + tick * 0,
    stalled,
    hasResponse
  )
  const notes = getFrontStageNotes(view)

  if (strip.mode === 'hidden' && notes.length === 0) {
    return null
  }

  return (
    <div className={styles.area}>
      {strip.mode === 'waiting' ? (
        <div className={styles.waiting} role="status" aria-live="polite">
          <span className={styles.iconSlot}>
            <WhaleLoader width={16} />
          </span>
          <span className={clsx(styles.headline, styles.shimmer)}>{strip.label}</span>
        </div>
      ) : strip.mode === 'live' ? (
        <div className={styles.liveWrap}>
          <button
            type="button"
            className={clsx(styles.stripButton, isInspecting && styles.stripButtonActive)}
            aria-pressed={isInspecting}
            aria-label={t('activityInspectLabel')}
            onClick={() => requestTurnInspection(sessionId, message.id, 'activity')}
          >
            <span className={styles.iconSlot}>
              {strip.waitingForUser ? (
                <span className={styles.waitingDot} aria-hidden="true">
                  <span className={styles.dotInner} />
                </span>
              ) : (
                <WhaleLoader width={16} />
              )}
            </span>
            <span className={clsx(styles.headline, styles.shimmer)}>{strip.headline}</span>
            {strip.tally ? <span className={styles.tally}>· {strip.tally}</span> : null}
            <span className={styles.chevron} aria-hidden="true">
              <IconChevronRightOutline14 />
            </span>
          </button>

          {strip.liveTracks.length > 0 ? (
            <div className={styles.liveAgents} role="status" aria-live="polite">
              {strip.liveTracks.map((track) => (
                <div key={track.id} className={styles.liveAgentRow}>
                  <span className={styles.liveAgentStatus} aria-hidden="true">
                    {track.status === 'running' ? (
                      <span className={styles.liveAgentDot} />
                    ) : track.status === 'failed' || track.status === 'stopped' ? (
                      <IconCloseFill14 />
                    ) : (
                      <IconCheckedOutline14 />
                    )}
                  </span>
                  <span className={styles.liveAgentLabel}>{track.label}</span>
                  {track.detail ? (
                    <span className={styles.liveAgentDetail}>— {track.detail}</span>
                  ) : null}
                </div>
              ))}
              {strip.overflowTracks > 0 ? (
                <div className={styles.liveAgentOverflow}>
                  {t('activityMoreTracks', { count: strip.overflowTracks })}
                </div>
              ) : null}
            </div>
          ) : strip.detail ? (
            <div className={styles.liveDetail} role="status" aria-live="polite">
              {strip.detail}
            </div>
          ) : null}
        </div>
      ) : strip.mode === 'settled' ? (
        <button
          type="button"
          className={clsx(
            styles.stripButton,
            styles.settledButton,
            isInspecting && styles.stripButtonActive
          )}
          aria-pressed={isInspecting}
          onClick={() => requestTurnInspection(sessionId, message.id, 'activity')}
        >
          <span
            className={clsx(
              styles.iconSlot,
              strip.stopped && styles.stoppedIcon,
              strip.errorCount > 0 && styles.errorIcon
            )}
          >
            {strip.errorCount > 0 ? <IconWarningOutline16 /> : <WhaleLoader width={15} still />}
          </span>
          <span className={styles.settledLabel}>{strip.label}</span>
          <span className={styles.chevron} aria-hidden="true">
            <IconChevronRightOutline14 />
          </span>
        </button>
      ) : null}

      {notes.length > 0 ? <FrontStageNotes notes={notes} /> : null}
    </div>
  )
})

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
