import {
  Button,
  IconButton,
  IconChevronRightOutline14,
  IconGlobeLanguageOutline16,
  IconRefreshOutline16,
} from '@deepseek-chat/lib-ui'
import clsx from 'clsx'
import { memo, useEffect, useState } from 'react'
import { useConversations } from '../../context.js'
import { describeReply } from '../../describe.js'
import { useTranslate } from '../../messages.js'
import { canContinueReply } from '../../reply.js'
import { type AssistantMessage as AssistantMessageType } from '../../types.js'
import { needsWorkingIndicator, type ReplyView } from '../../view.js'
import styles from './AssistantMessage.module.css'
import {
  BranchSwitcher,
  type MessageVersions,
  type SelectMessageVersion,
} from './BranchSwitcher.js'
import { ChatMarkdown as Markdown } from './ChatMarkdown.js'
import { CopyButton } from './CopyButton.js'
import { DeliveredFileCard, ReplyArea } from './ReplyArea.js'
import { useReplyView } from './useReplyView.js'
import { WhaleLoader } from './WhaleLoader.js'

const TOP_UP_URL = 'https://platform.deepseek.com/top_up'
const STALL_DELAY_MS = 1500
const useNoInspection = () => null
/** How long text after a tool call streams before it counts as the answer. */
const NARRATION_HOLD_MS = 1200
/** Text this long, or with a paragraph break, is the answer at once. */
const NARRATION_MAX_CHARS = 280

/**
 * In a reply that has used tools, text after the latest tool call is usually a line of narration
 * ("That didn't work. Let me check…") that folds into the steps as soon as the next call starts.
 * Shown as the answer, it flashes in and out and makes the transcript jump. So while the reply
 * streams, hold such text back (the work strip stays live) until it is long, has a paragraph break,
 * or has streamed for `NARRATION_HOLD_MS` with no tool call after it.
 */
const useHeldAnswer = (
  messageId: string,
  answer: ReplyView['answer'],
  streaming: boolean,
  steps: ReplyView['steps']
): ReplyView['answer'] => {
  const afterTools = steps.some((step) => step.type === 'tool')
  const key = `${messageId}:${steps.length}`
  const candidate = streaming && afterTools && answer !== null
  const [since, setSince] = useState<{ readonly key: string; readonly at: number } | null>(null)
  const [, setTick] = useState(0)
  if (candidate && since?.key !== key) {
    setSince({ key, at: Date.now() })
  }
  const elapsed = candidate && since?.key === key ? Date.now() - since.at : 0
  const decided =
    answer !== null &&
    (answer.text.length >= NARRATION_MAX_CHARS || /\n\s*\n/.test(answer.text.trim()))
  const held = candidate && !decided && elapsed < NARRATION_HOLD_MS
  useEffect(() => {
    if (!held) {
      return
    }
    const timer = setTimeout(() => setTick((n) => n + 1), NARRATION_HOLD_MS - elapsed + 16)
    return () => clearTimeout(timer)
  }, [held, key, elapsed])
  return held ? null : answer
}

const useStalled = (message: object, streaming: boolean, delay: number) => {
  const [stalledAt, setStalledAt] = useState<object | null>(null)
  useEffect(() => {
    if (!streaming) {
      return
    }
    const timer = setTimeout(() => setStalledAt(message), delay)
    return () => clearTimeout(timer)
  }, [message, streaming, delay])
  return streaming && stalledAt === message
}

export const AssistantMessage = memo(function AssistantMessage({
  sessionId,
  message,
  isLast,
  streaming,
  compacting = false,
  busy,
  versions,
  onSelectVersion,
}: {
  sessionId: string
  message: AssistantMessageType
  isLast: boolean
  streaming: boolean
  compacting?: boolean
  busy: boolean
  versions: MessageVersions
  onSelectVersion: SelectMessageVersion
}) {
  const t = useTranslate()
  const { deps, requestTurnInspection, regenerateReply, continueReply } = useConversations()
  const ReadAloudButton = deps.ui.voice?.ReadAloudButton ?? null
  const view = useReplyView(message, streaming)
  const useActiveInspection = deps.ui.useActiveInspectionTarget ?? useNoInspection
  const panelTarget = useActiveInspection()
  const notice = streaming ? null : describeReply(message)
  const refused = message.stopReason === 'refusal'
  const shownAnswer = useHeldAnswer(message.id, view.answer, streaming, view.steps)
  const answer = refused ? null : shownAnswer
  const responseText = [answer?.text, notice?.presentation === 'response' ? notice.text : null]
    .filter(Boolean)
    .join('\n\n')
  const copyText = responseText || notice?.text
  const stalled = useStalled(message, streaming, STALL_DELAY_MS)
  const midAnswerStalled = Boolean(answer) && stalled && !refused && needsWorkingIndicator(view)

  const totalSources = view.sources.length
  const citedCount = view.citedSourceIndexes.length
  const sourcesLabel =
    citedCount > 0 && totalSources > citedCount
      ? t('activitySourcesCitedSummary', { cited: citedCount, total: totalSources })
      : t(totalSources === 1 ? 'activityCountSourceOne' : 'activityCountSourceMany', {
          count: totalSources,
        })
  const isSourcesOpen =
    panelTarget !== null &&
    panelTarget.sessionId === sessionId &&
    panelTarget.messageId === message.id &&
    panelTarget.tab === 'sources'

  return (
    <div className={styles.message}>
      {refused ? null : (
        <ReplyArea
          sessionId={sessionId}
          message={message}
          view={view}
          streaming={streaming}
          compacting={compacting}
          stalled={stalled}
          hasResponse={!!responseText}
        />
      )}
      {answer ? (
        <Markdown
          className="ds-assistant-message-main-content"
          content={answer.markdown}
          loading={streaming}
          cacheKey={message.id}
          disableLink={false}
          sources={view.sources}
        />
      ) : null}
      {!refused && view.images.length > 0 ? (
        <div className={styles.images}>
          {view.images.map((src, index) => (
            <img
              key={src}
              src={src}
              alt={t('activityOutputImageAlt', { index: index + 1 })}
              className={styles.outputImage}
            />
          ))}
        </div>
      ) : null}
      {view.files.length > 0 ? (
        <div className={styles.files}>
          {view.files.map((file) => (
            <DeliveredFileCard key={file.path ?? file.name} sessionId={sessionId} file={file} />
          ))}
        </div>
      ) : null}
      {midAnswerStalled ? (
        <div className={styles.working} role="status" aria-live="polite">
          <WhaleLoader width={16} />
          <span className={styles.workingText}>{t('replyWorking')}</span>
        </div>
      ) : null}
      {notice?.presentation === 'response' ? (
        <Markdown
          className="ds-assistant-message-main-content"
          content={notice.text}
          loading={false}
          cacheKey={`${message.id}-template`}
          disableLink={false}
        />
      ) : notice ? (
        <div className={styles.notice}>
          <span>
            {notice.text}
            {notice.action === 'apiKey' ? (
              <>
                {' '}
                <button
                  type="button"
                  className={styles.noticeAction}
                  onClick={() => deps.ui.openSettings('apiKey')}
                >
                  {t('changeApiKey')}
                </button>
              </>
            ) : null}
            {notice.action === 'topUp' ? (
              <>
                {' '}
                <a
                  className={styles.noticeAction}
                  href={TOP_UP_URL}
                  target="_blank"
                  rel="noreferrer"
                >
                  {t('topUp')}
                </a>
              </>
            ) : null}
          </span>
        </div>
      ) : null}
      {!streaming && !refused && totalSources > 0 ? (
        <button
          type="button"
          className={clsx(styles.summary, isSourcesOpen && styles.summaryActive)}
          aria-pressed={isSourcesOpen}
          aria-label={t('activitySourcesLabel')}
          onClick={() => requestTurnInspection(sessionId, message.id, 'sources')}
        >
          <span className={styles.sourcesIcon} aria-hidden="true">
            <IconGlobeLanguageOutline16 />
          </span>
          <span className={styles.sourcesLabel}>{sourcesLabel}</span>
          <span className={styles.sourcesChevron} aria-hidden="true">
            <IconChevronRightOutline14 />
          </span>
        </button>
      ) : null}
      {streaming ? null : (
        <div className={styles.bottom}>
          <BranchSwitcher versions={versions} disabled={busy} onSelect={onSelectVersion} />
          <div className={clsx(styles.actions, isLast && styles.alwaysShow)}>
            {copyText ? <CopyButton text={copyText} /> : null}
            {responseText && !refused && ReadAloudButton ? (
              <ReadAloudButton messageId={message.id} text={responseText} />
            ) : null}
            <IconButton
              icon={<IconRefreshOutline16 />}
              tooltip={t('regenerate')}
              tooltipPlacement="bottom"
              disabled={busy || refused}
              onClick={() => regenerateReply(sessionId, message.id)}
            />
          </div>
          {isLast && canContinueReply(message) ? (
            <Button
              variant="outlined"
              size="s"
              className={styles.continueButton}
              disabled={busy}
              onClick={() => continueReply(sessionId, message.id)}
            >
              {t('continueGenerating')}
            </Button>
          ) : null}
        </div>
      )}
    </div>
  )
})
