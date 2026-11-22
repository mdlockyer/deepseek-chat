import { useTranslate } from '../../messages.js'
import clsx from 'clsx'
import { memo, useEffect, useState } from 'react'
import { IconRefreshOutline16, IconWarningOutline16 } from '@deepseek-chat/spine/design'
import { describeReply } from '../../describe.js'
import { canContinueReply } from '../../reply.js'
import { continueReply, regenerateReply } from '../../store.js'
import { type AssistantMessage as AssistantMessageType } from '../../types.js'
import { deps } from '../../env.js'
import { IconButton } from '@deepseek-chat/spine/design'
import { Button } from '@deepseek-chat/spine/design'
import { ChatMarkdown as Markdown } from './ChatMarkdown.js'
import { SiteThumbnails } from '../search/SiteLogo.js'
import { toggleSearchPanel, useSearchPanel } from '../search/searchPanelState.js'
import { CopyButton } from './CopyButton.js'
import { ReplyArea } from './ReplyArea.js'
import { needsWorkingIndicator } from '../../view.js'
import { useReplyView } from './useReplyView.js'
import {
  BranchSwitcher,
  type MessageVersions,
  type SelectMessageVersion,
} from './BranchSwitcher.js'
import styles from './AssistantMessage.module.css'

const TOP_UP_URL = 'https://platform.deepseek.com/top_up'

/** 生成中的回复超过这么久没有新内容，就提示仍在处理 */
const STALL_DELAY_MS = 1500

/**
 * 生成中且自上次内容变化起已过 `delay`：每个流式事件都会换掉消息对象，变化即重新计时。
 * 记录「哪个消息对象停住了」，内容一变就自动失效，不必在 effect 里重置状态。
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
  const panelEntry = useSearchPanel((state) => state.entry)
  const notice = streaming ? null : describeReply(message)
  // 安全拒绝：已下发的思考与正文按协议丢弃，只显示模板答复。
  const refused = message.stopReason === 'refusal'
  const answer = refused ? null : view.answer
  const responseText = [answer?.text, notice?.presentation === 'response' ? notice.text : null]
    .filter(Boolean)
    .join('\n\n')
  const copyText = responseText || notice?.text
  const waiting = streaming && view.steps.length === 0 && !view.answer && !message.thinking
  const stalled = useStalled(message, streaming, STALL_DELAY_MS)
  const working = stalled && !waiting && !refused && needsWorkingIndicator(view)
  const summaryEntry = `${message.id}-summary`
  return (
    <div className={styles.message}>
      {refused ? null : (
        <ReplyArea
          sessionId={sessionId}
          message={message}
          view={view}
          streaming={streaming}
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
      {waiting ? (
        <div className={styles.waiting}>
          {[0, 1, 2].map((index) => (
            <span key={index} className={styles.waitingDot} />
          ))}
        </div>
      ) : null}
      {working ? (
        <div className={styles.working} role="status">
          {t('replyWorking')}
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
                  onClick={() => deps().ui.openSettings('data')}
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
      {!streaming && !refused && view.searchResults.length > 0 ? (
        <div
          className={clsx(styles.summary, panelEntry === summaryEntry && styles.summaryActive)}
          onClick={() => toggleSearchPanel(summaryEntry, view.searchResults)}
        >
          <SiteThumbnails sources={view.searchResults} />
          <span>
            {t(
              view.searchResults.length === 1 ? 'messageSearchSummary' : 'messageSearchSummaries',
              { count: view.searchResults.length }
            )}
          </span>
        </div>
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
