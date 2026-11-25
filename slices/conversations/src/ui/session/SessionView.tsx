import { useIsMobile } from '@deepseek-chat/lib-ui'
import clsx from 'clsx'
import { useConversations } from '../../context.js'
import { sessionTitle } from '../../format.js'
import { useTranslate } from '../../messages.js'
import { type Session } from '../../types.js'
import { ChatInput } from '../chatInput/ChatInput.js'
import { MessageList } from '../messages/MessageList.js'
import { MobileHeader } from './MobileHeader.js'
import styles from './SessionView.module.css'

const useNoDock = () => false

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
  const { deps, stopReply } = useConversations()
  const { headerActions = [], composerDock: ComposerDock, useHasComposerDock = useNoDock } = deps.ui
  const hasDock = useHasComposerDock(session.id)
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
          {headerActions.length > 0 ? (
            <div className={styles.headerActions}>
              {headerActions.map((Action, index) => (
                <Action key={index} sessionId={session.id} />
              ))}
            </div>
          ) : null}
        </div>
      )}
      <MessageList
        session={session}
        streaming={streaming}
        footer={
          <div className={styles.inputContainer}>
            {hasDock && ComposerDock ? (
              <ComposerDock sessionId={session.id} onStopReply={() => stopReply(session.id)} />
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
