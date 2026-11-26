import { IconChevronRightOutline14, IconKeyOutline16, useIsMobile } from '@deepseek-chat/lib-ui'
import clsx from 'clsx'
import { useConversations } from '../../context.js'
import { useTranslate } from '../../messages.js'
import type { SiderMode } from '../../views.js'
import { DeepSeekMark } from '../brand/DeepSeekMark.js'
import { MobileHeader } from './MobileHeader.js'
import { SettingsHeaderButton } from './SettingsHeaderButton.js'
import styles from './Welcome.module.css'

const useNoNeedsApiKey = () => false

/**
 * New chat, above the composer: the brand in the title position and the greeting. The session
 * stage places the composer under it and `WelcomeBelow` under that, so the composer stays one
 * element when the first message turns this screen into a conversation.
 */
export const WelcomeAbove = ({ siderMode }: { siderMode: SiderMode }) => {
  const t = useTranslate()
  const isMobile = useIsMobile()
  return (
    <div className={styles.above}>
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
          <div
            className={styles.brand}
            data-tauri-drag-region="deep"
            data-stage-exit="brand"
            data-stage-enter="brand"
          >
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
      <div className={styles.greeting} data-stage-exit="greeting" data-stage-enter="greeting">
        {t('welcomeMessageChat250808')}
      </div>
    </div>
  )
}

/** New chat, below the composer: the API key cue when no key is set, and the caveat on mobile. */
export const WelcomeBelow = () => {
  const t = useTranslate()
  const isMobile = useIsMobile()
  const { deps } = useConversations()
  const needsApiKey = (deps.ui.useNeedsApiKey ?? useNoNeedsApiKey)()
  return (
    <div className={styles.below} data-stage-exit="below" data-stage-enter="below">
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
  )
}
