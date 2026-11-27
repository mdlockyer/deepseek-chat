import { IconButton, IconMenuOutline20, IconNewChatOutline20 } from '@deepseek-chat/lib-ui'
import { useTranslate } from '../../../../kernel/index.js'
import { useConversations } from '../../context.js'
import { DeepSeekMark } from '../brand/DeepSeekMark.js'
import styles from './MobileHeader.module.css'
import { SettingsHeaderButton } from './SettingsHeaderButton.js'

/** 移动端顶栏：无历史会话时隐藏空白抽屉菜单并展示品牌；右上角常驻设置按钮 */
export const MobileHeader = ({ title }: { title?: string }) => {
  const t = useTranslate()
  const { useChatState, newChat, openMobileSider } = useConversations()
  const hasSessions = useChatState((state) => state.sessions.length > 0)
  return (
    <div className={styles.header} data-tauri-drag-region>
      {hasSessions ? (
        <IconButton
          size="xl"
          tone="primary"
          icon={<IconMenuOutline20 />}
          aria-label={t('expandSiderbarButton')}
          onClick={openMobileSider}
        />
      ) : title === undefined ? (
        <div className={styles.brand} data-tauri-drag-region="deep">
          <span className={styles.brandMark}>
            <DeepSeekMark height={17} />
          </span>
          <span className={styles.brandName}>{t('appName')}</span>
        </div>
      ) : null}
      {title === undefined ? null : (
        <div className={styles.title} data-tauri-drag-region>
          {title}
        </div>
      )}
      <div className={styles.actions}>
        {title === undefined ? null : (
          <IconButton
            size="xl"
            tone="primary"
            icon={<IconNewChatOutline20 />}
            aria-label={t('newChat')}
            onClick={newChat}
          />
        )}
        <SettingsHeaderButton mobile />
      </div>
    </div>
  )
}
