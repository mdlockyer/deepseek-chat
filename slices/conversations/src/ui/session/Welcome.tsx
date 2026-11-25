import { IconChevronRightOutline14, IconKeyOutline16, useIsMobile } from '@deepseek-chat/lib-ui'
import clsx from 'clsx'
import { useConversations } from '../../context.js'
import { useTranslate } from '../../messages.js'
import type { SiderMode } from '../../views.js'
import { DeepSeekMark } from '../brand/DeepSeekMark.js'
import { ChatInput } from '../chatInput/ChatInput.js'
import { MobileHeader } from './MobileHeader.js'
import { SettingsHeaderButton } from './SettingsHeaderButton.js'
import styles from './Welcome.module.css'

const useNoNeedsApiKey = () => false

/** 新对话：问候语 + 输入框 + 未配置 API Key 时的轻量内联提示。桌面端居中；移动端输入框吸底 */
export const Welcome = ({ siderMode }: { siderMode: SiderMode }) => {
  const t = useTranslate()
  const isMobile = useIsMobile()
  const { deps } = useConversations()
  const needsApiKey = (deps.ui.useNeedsApiKey ?? useNoNeedsApiKey)()
  return (
    <div className={styles.container}>
      {isMobile ? (
        <MobileHeader />
      ) : (
        // 新对话时品牌占住会话标题的位置，与交通灯同一水平线；右侧常驻设置按钮
        <div
          className={clsx(
            styles.detailBrand,
            siderMode === 'absent' && styles.withAbsentSider,
            siderMode === 'collapsed' && styles.withCollapsedSider
          )}
          data-tauri-drag-region
        >
          <div className={styles.brand} data-tauri-drag-region="deep">
            <span className={styles.brandMark}>
              <DeepSeekMark height={17} />
            </span>
            <span className={styles.brandName}>{t('appName')}</span>
          </div>
          <div className={styles.headerActions}>
            <SettingsHeaderButton />
          </div>
        </div>
      )}
      <div className={styles.welcome}>
        <div className={styles.greeting}>{t('welcomeMessageChat250808')}</div>
        <ChatInput sessionId={null} />
        {needsApiKey ? (
          <button
            type="button"
            className={styles.apiKeyCue}
            onClick={() => deps.ui.openSettings('apiKey')}
          >
            <span className={styles.apiKeyCueIcon} aria-hidden>
              <IconKeyOutline16 />
            </span>
            <span className={styles.apiKeyCueText}>{t('apiKeySetupCue')}</span>
            <span className={styles.apiKeyCueArrow} aria-hidden>
              <IconChevronRightOutline14 />
            </span>
          </button>
        ) : null}
        {isMobile ? <div className={styles.caveat}>{t('contentCaveat')}</div> : null}
      </div>
    </div>
  )
}
