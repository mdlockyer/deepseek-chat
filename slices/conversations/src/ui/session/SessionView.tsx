import {
  IconBrowseOutline16,
  IconButton,
  IconGlobeLanguageOutline16,
  useIsMobile,
} from '@deepseek-chat/lib-ui'
import clsx from 'clsx'
import { deps } from '../../env.js'
import { sessionTitle } from '../../format.js'
import { useTranslate } from '../../messages.js'
import { type Session } from '../../types.js'
import type { ChatPanels } from '../../views.js'
import { useAskUserStore } from '../../askUser.js'
import { AskUserCard } from '../ask/AskUserCard.js'
import { ChatInput } from '../chatInput/ChatInput.js'
import { MessageList } from '../messages/MessageList.js'
import { MobileHeader } from './MobileHeader.js'
import styles from './SessionView.module.css'

/** 会话页：标题栏（移动端为顶栏）+ 消息列表，输入框吸底 */
export const SessionView = ({
  session,
  streaming,
  siderCollapsed,
}: {
  session: Session
  streaming: boolean
  siderCollapsed: boolean
}) => {
  const t = useTranslate()
  const isMobile = useIsMobile()
  const { panels } = deps().ui
  const filesToggle = panels.files.useToggle(session)
  const hasPendingAsk = useAskUserStore((state) => Boolean(state.pendingBySession[session.id]))
  const title = sessionTitle(session, t('untitledChat'))
  return (
    <div className={styles.view}>
      {isMobile ? (
        <MobileHeader title={title} />
      ) : (
        <div className={styles.header} data-tauri-drag-region>
          <div
            className={clsx(styles.title, siderCollapsed && styles.withCollapsedSider)}
            data-tauri-drag-region
          >
            {title}
          </div>
          {filesToggle.visible || panels.browser ? (
            <div className={styles.headerActions}>
              {filesToggle.visible ? (
                <IconButton
                  size="m"
                  tone="primary"
                  className={clsx(filesToggle.open && styles.browserButtonActive)}
                  icon={<IconBrowseOutline16 />}
                  tooltip={t(filesToggle.open ? 'previewClosePanel' : 'previewOpenPanel')}
                  tooltipPlacement="bottom"
                  aria-pressed={filesToggle.open}
                  onClick={filesToggle.toggle}
                />
              ) : null}
              {panels.browser ? (
                <BrowserToggle browser={panels.browser} sessionId={session.id} />
              ) : null}
            </div>
          ) : null}
        </div>
      )}
      <MessageList
        session={session}
        streaming={streaming}
        footer={
          <div className={styles.inputContainer}>
            {hasPendingAsk ? (
              <AskUserCard sessionId={session.id} />
            ) : (
              <ChatInput sessionId={session.id} />
            )}
            <div className={styles.caveat}>{t('contentCaveat')}</div>
          </div>
        }
      />
    </div>
  )
}

/** 内置浏览器的开关（仅桌面端） */
const BrowserToggle = ({
  browser,
  sessionId,
}: {
  browser: NonNullable<ChatPanels['browser']>
  sessionId: string
}) => {
  const t = useTranslate()
  const { open, toggle } = browser.useToggle(sessionId)
  return (
    <IconButton
      size="m"
      tone="primary"
      className={clsx(open && styles.browserButtonActive)}
      icon={<IconGlobeLanguageOutline16 />}
      tooltip={t(open ? 'closeBrowser' : 'openBrowser')}
      tooltipPlacement="bottom"
      aria-pressed={open}
      onClick={toggle}
    />
  )
}
