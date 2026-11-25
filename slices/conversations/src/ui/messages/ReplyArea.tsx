import clsx from 'clsx'
import { memo, useEffect, useState } from 'react'
import {
  IconCheckedOutline14,
  IconChevronRightOutline14,
  IconCloseFill14,
  IconWarningOutline16,
} from '@deepseek-chat/lib-ui'
import { buildTurnWorkStrip, getFrontStageAsks } from '../../activityView.js'
import { formatSize, getExtension } from '../../attachments.js'
import { loadFile } from '../../db.js'
import { deps } from '../../env.js'
import { useTranslate } from '../../messages.js'
import type { AssistantMessage, PresentedFileRef } from '../../types.js'
import type { AskStep, ReplyView } from '../../view.js'
import { toggleActivityPanel, useActivityPanel } from '../activity/activityPanelState.js'
import { FileCard } from '../files/FileCard.js'
import styles from './ReplyArea.module.css'
import { WhaleLoader } from './WhaleLoader.js'

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
 * - While working: bounded 2-line live ticker (<= 4 compact lines for parallel subagents),
 *   so completed tool calls never accumulate as a wall pushing the user's question off-screen.
 * - Once answered or finished: collapses automatically to a single quiet summary button that
 *   opens the unified right-hand Activity & Sources panel.
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
  const target = useActivityPanel((state) => state.target)
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
  const asks = getFrontStageAsks(view)

  if (strip.mode === 'hidden' && asks.length === 0) {
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
            onClick={() => toggleActivityPanel(sessionId, message.id, 'activity')}
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

          {strip.liveAgents.length > 0 ? (
            <div className={styles.liveAgents} role="status" aria-live="polite">
              {strip.liveAgents.map((agent) => (
                <div key={agent.runId} className={styles.liveAgentRow}>
                  <span className={styles.liveAgentStatus} aria-hidden="true">
                    {agent.status === 'running' ? (
                      <span className={styles.liveAgentDot} />
                    ) : agent.status === 'failed' || agent.status === 'stopped' ? (
                      <IconCloseFill14 />
                    ) : (
                      <IconCheckedOutline14 />
                    )}
                  </span>
                  <span className={styles.liveAgentLabel}>{agent.label}</span>
                  {agent.detail ? (
                    <span className={styles.liveAgentDetail}>— {agent.detail}</span>
                  ) : null}
                </div>
              ))}
              {strip.overflowAgents > 0 ? (
                <div className={styles.liveAgentOverflow}>
                  {t('activityMoreAgents', { count: strip.overflowAgents })}
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
          onClick={() => toggleActivityPanel(sessionId, message.id, 'activity')}
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

      {asks.length > 0 ? <FrontStageAsks asks={asks} /> : null}
    </div>
  )
})

const FrontStageAsks = ({ asks }: { asks: AskStep[] }) => {
  const t = useTranslate()
  return (
    <div className={styles.frontAsks}>
      {asks.map((step) => {
        const ask = step.askAction
        if (!ask) {
          return null
        }
        if (ask.status === 'skipped') {
          return (
            <div key={step.key} className={styles.frontAskRow}>
              <IconCheckedOutline14 />
              <span>{t('askSkipped')}</span>
            </div>
          )
        }
        const answered = ask.items.filter((item) =>
          Array.isArray(item.answer) ? item.answer.length > 0 : Boolean(item.answer)
        )
        if (answered.length === 0) {
          return null
        }
        return (
          <div key={step.key} className={styles.frontAskRow}>
            {answered.map((item) => (
              <span key={item.id} className={styles.askEntry}>
                <span className={styles.askEntryKey}>{item.header}:</span>
                <span className={styles.askEntryVal}>
                  {Array.isArray(item.answer) ? item.answer.join(', ') : item.answer}
                </span>
              </span>
            ))}
          </div>
        )
      })}
    </div>
  )
}

/** 从 IndexedDB 读取原件交给应用保存（桌面端保存对话框，网页端下载）；原件缺失时返回 false */
const downloadStoredFile = async (file: PresentedFileRef): Promise<boolean> => {
  const blob = await loadFile(file.id)
  if (!blob) {
    return false
  }
  await deps().ui.saveFile(file.name, blob)
  return true
}

/** 统一的可预览与下载文件卡片：点击在右侧文件面板预览，右侧按钮可直接保存 */
export const PresentedFileCard = ({
  sessionId,
  file,
}: {
  sessionId: string
  file: PresentedFileRef
}) => {
  const t = useTranslate()
  const [missing, setMissing] = useState(false)
  const { files } = deps().ui.panels
  const shownFile = { kind: 'presented', file } as const
  const isOpen = files.useIsShown(sessionId, shownFile)

  const ext = getExtension(file.name)
  const versionTag = file.version !== undefined && file.version > 1 ? `v${file.version}` : undefined
  const subtitle = [ext, formatSize(file.size), versionTag].filter(Boolean).join(' · ')

  return (
    <FileCard
      name={file.name}
      title={file.title}
      size={file.size}
      subtitle={missing ? t('pythonFileMissing') : subtitle}
      status={missing ? 'error' : 'done'}
      error={missing ? t('pythonFileMissing') : undefined}
      active={isOpen}
      onOpen={() => files.open(sessionId, shownFile)}
      onDownload={() => {
        void downloadStoredFile(file).then(
          (ok) => setMissing(!ok),
          () => setMissing(true)
        )
      }}
    />
  )
}
