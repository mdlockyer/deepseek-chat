import clsx from 'clsx'
import { useIsMobile } from '../../app/viewport.js'
import { useTranslate } from '../../i18n/index.js'
import type { TranslationKey } from '../../i18n/index.js'
import { setDraftText } from '../../services/chat/drafts.js'
import { ChatInput, focusChatComposer } from '../chatInput/ChatInput.js'
import { DeepSeekMark } from '../base/logo.js'
import { MobileHeader } from './MobileHeader.js'
import styles from './Welcome.module.css'

/** 首次进入或新建对话时的示例问题：点一下填入输入框，让用户看到这个应用能做什么 */
const starters: { label: TranslationKey; prompt: TranslationKey }[] = [
  { label: 'welcomeStarterPythonLabel', prompt: 'welcomeStarterPythonPrompt' },
  { label: 'welcomeStarterSearchLabel', prompt: 'welcomeStarterSearchPrompt' },
  { label: 'welcomeStarterExplainLabel', prompt: 'welcomeStarterExplainPrompt' },
]

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
        <div className={styles.starters}>
          {starters.map((starter) => (
            <button
              key={starter.label}
              type="button"
              className={styles.starter}
              onClick={() => {
                setDraftText(null, t(starter.prompt))
                focusChatComposer()
              }}
            >
              {t(starter.label)}
            </button>
          ))}
        </div>
        {isMobile ? <div className={styles.caveat}>{t('contentCaveat')}</div> : null}
      </div>
    </div>
  )
}
