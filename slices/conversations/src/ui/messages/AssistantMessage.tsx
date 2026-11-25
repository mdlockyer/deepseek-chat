import clsx from 'clsx'
import { memo, useEffect, useState } from 'react'
import {
  Button,
  IconButton,
  IconGlobeLanguageOutline16,
  IconRefreshOutline16,
  IconWarningOutline16,
} from '@deepseek-chat/lib-ui'
import { describeReply } from '../../describe.js'
import { deps } from '../../env.js'
import { useTranslate } from '../../messages.js'
import { canContinueReply } from '../../reply.js'
import { continueReply, regenerateReply } from '../../store.js'
import { type AssistantMessage as AssistantMessageType } from '../../types.js'
import { needsWorkingIndicator } from '../../view.js'
import { toggleActivityPanel, useActivityPanel } from '../activity/activityPanelState.js'
import styles from './AssistantMessage.module.css'
import {
  BranchSwitcher,
  type MessageVersions,
  type SelectMessageVersion,
} from './BranchSwitcher.js'
import { ChatMarkdown as Markdown } from './ChatMarkdown.js'
import { CopyButton } from './CopyButton.js'
import { PresentedFileCard, ReplyArea } from './ReplyArea.js'
import { useReplyView } from './useReplyView.js'
import { WhaleLoader } from './WhaleLoader.js'

const TOP_UP_URL = 'https://platform.deepseek.com/top_up'

/** 生成中的回复超过这么久没有新内容，就提示仍在处理 */
const STALL_DELAY_MS = 1500

/**
 * 生成中且自上次内容变化起已过 `delay`：每个流式事件都会换掉消息对象，变化即重新计时。
 */
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
  const { ReadAloudButton } = deps().ui.voice
  const view = useReplyView(message, streaming)
  const panelTarget = useActivityPanel((state) => state.target)
  const notice = streaming ? null : describeReply(message)
  // 安全拒绝：已下发的思考与正文按协议丢弃，只显示模板答复。
  const refused = message.stopReason === 'refusal'
  const answer = refused ? null : view.answer
  const responseText = [answer?.text, notice?.presentation === 'response' ? notice.text : null]
    .filter(Boolean)
    .join('\n\n')
  const copyText = responseText || notice?.text
  const stalled = useStalled(message, streaming, STALL_DELAY_MS)
  // Before answer text starts, ReplyArea shows stalls in-place inside its bounded live slot.
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
            <PresentedFileCard key={file.path ?? file.name} sessionId={sessionId} file={file} />
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
                  onClick={() => deps().ui.openSettings('apiKey')}
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
          onClick={() => toggleActivityPanel(sessionId, message.id, 'sources')}
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
            {responseText && !refused ? (
              <ReadAloudButton messageId={message.id} text={responseText} />
            ) : null}
            <IconButton
              icon={<IconRefreshOutline16 />}
              tooltip={t('regenerate')}
              tooltipPlacement="bottom"
              disabled={busy || refused}
              onClick={() => {
                deps().ui.voice.stopReadAloud()
                regenerateReply(sessionId, message.id)
              }}
            />
          </div>
          {isLast && canContinueReply(message) ? (
            <Button
              variant="outlined"
              size="s"
              className={styles.continueButton}
              disabled={busy}
              onClick={() => {
                deps().ui.voice.stopReadAloud()
                continueReply(sessionId, message.id)
              }}
            >
              {t('continueGenerating')}
            </Button>
          ) : null}
        </div>
      )}
    </div>
  )
})
