import { useIsMobile } from '@deepseek-chat/lib-ui'
import clsx from 'clsx'
import { sessionTitle, useTranslate, type Session } from '../../../../kernel/index.js'
import { useConversations } from '../../context.js'
import type { SiderMode } from '../../views.js'
import { MessageList } from '../messages/MessageList.js'
import { SwapLabel } from '../messages/SwapLabel.js'
import { MobileHeader } from './MobileHeader.js'
import styles from './SessionView.module.css'
import { SettingsHeaderButton } from './SettingsHeaderButton.js'

/**
 * Conversation, above the composer: the title bar (top bar on mobile) and the message list. The
 * session stage places the composer under it.
 */
export const SessionView = ({
  session,
  streaming,
  compacting,
  siderMode,
}: {
  session: Session
  streaming: boolean
  compacting: boolean
  siderMode: SiderMode
}) => {
  const t = useTranslate()
  const isMobile = useIsMobile()
  const { deps, activity } = useConversations()
  const { headerActions = [] } = deps.ui
  const ActivityHeaderToggle = activity?.HeaderToggle ?? null
  const title = sessionTitle(session, t('untitledChat'))
  return (
    <div className={styles.view}>
      {isMobile ? (
        <MobileHeader title={title} />
      ) : (
        <div className={styles.header} data-tauri-drag-region>
          <div
            className={clsx(styles.title, siderMode === 'collapsed' && styles.withCollapsedSider)}
            data-tauri-drag-region
            data-stage-exit="title"
            data-stage-enter="title"
          >
            <SwapLabel swapKey={title} className={styles.titleText}>
              {title}
            </SwapLabel>
          </div>
          <div className={styles.headerActions}>
            {headerActions.length > 0 || ActivityHeaderToggle ? (
              <div
                className={styles.sessionActions}
                data-stage-exit="actions"
                data-stage-enter="actions"
              >
                {headerActions.map((Action, index) => (
                  <Action key={index} sessionId={session.id} />
                ))}
                {ActivityHeaderToggle ? <ActivityHeaderToggle sessionId={session.id} /> : null}
              </div>
            ) : null}
            <SettingsHeaderButton />
          </div>
        </div>
      )}
      <div className={styles.list} data-stage-exit="list">
        <MessageList session={session} streaming={streaming} compacting={compacting} />
      </div>
    </div>
  )
}
