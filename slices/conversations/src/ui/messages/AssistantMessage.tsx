import {
  Button,
  IconButton,
  IconGlobeLanguageOutline16,
  IconRefreshOutline16,
  IconWarningOutline16,
} from '@deepseek-chat/lib-ui'
import clsx from 'clsx'
import { memo, useEffect, useState } from 'react'
import { useConversations } from '../../context.js'
import { describeReply } from '../../describe.js'
import { useTranslate } from '../../messages.js'
import { canContinueReply } from '../../reply.js'
import { type AssistantMessage as AssistantMessageType } from '../../types.js'
import { needsWorkingIndicator } from '../../view.js'
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
  busy,
  versions,
  onSelectVersion,
}: {
  sessionId: string
  message: AssistantMessageType
  isLast: boolean
  streaming: boolean
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
  const answer = refused ? null : view.answer
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
          <IconWarningOutline16 />
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
