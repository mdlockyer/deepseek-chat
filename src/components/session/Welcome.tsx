import clsx from 'clsx'
import { useIsMobile } from '../../app/viewport.js'
import { useTranslate } from '../../i18n/index.js'
import { ChatInput } from '../chatInput/ChatInput.js'
import { DeepSeekMark } from '@deepseek-chat/spine/design'
import { MobileHeader } from './MobileHeader.js'
import styles from './Welcome.module.css'

/** 新对话：问候语 + 输入框。桌面端居中；移动端输入框吸底 */
export const Welcome = ({ siderCollapsed }: { siderCollapsed: boolean }) => {
  const t = useTranslate()
  const isMobile = useIsMobile()
  return (
    <div className={styles.container}>
      {isMobile ? (
        <MobileHeader />
      ) : (
        // 新对话时品牌占住会话标题的位置，与交通灯同一水平线；打开会话后换回会话标题
        <div
          className={clsx(styles.detailBrand, siderCollapsed && styles.withCollapsedSider)}
          data-tauri-drag-region="deep"
        >
          <span className={styles.brandMark}>
            <DeepSeekMark height={17} />
          </span>
          <span className={styles.brandName}>{t('appName')}</span>
        </div>
      )}
      <div className={styles.welcome}>
        <div className={styles.greeting}>{t('welcomeMessageChat250808')}</div>
        <ChatInput sessionId={null} />
        {isMobile ? <div className={styles.caveat}>{t('contentCaveat')}</div> : null}
      </div>
    </div>
  )
}
