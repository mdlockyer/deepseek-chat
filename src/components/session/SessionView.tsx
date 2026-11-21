import clsx from 'clsx'
import { useMemo } from 'react'
import { useIsMobile } from '../../app/viewport.js'
import { useTranslate } from '../../i18n/index.js'
import { isDesktopApp } from '../../platform/desktop.js'
import { toggleBrowserPanel } from '../../services/browser/state.js'
import { getVisibleMessages } from '../../services/chat/branches.js'
import type { Session } from '../../services/chat/types.js'
import {
  EMPTY_SESSION_PREVIEW_STATE,
  togglePreviewPanel,
  usePreviewStore,
} from '../../services/preview/state.js'
import { collectWorkspaceArtifacts } from '../../services/preview/workspace.js'
import { useSettings } from '../../services/settings.js'
import { getActiveRightPanel, useSidePanelStore } from '../../services/sidePanel/state.js'
import { sessionTitle } from '../../utils/format.js'
import { IconButton } from '../base/IconButton.js'
import { IconBrowseOutline16, IconGlobeLanguageOutline16 } from '../base/icons.js'
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
  const locale = useSettings((state) => state.locale)
  const activePanel = useSidePanelStore((state) => getActiveRightPanel(session.id, state))
  const browserOpen = activePanel === 'browser'
  const previewOpen = activePanel === 'preview'
  const hasOpenPreview = usePreviewStore(
    (state) =>
      (Object.hasOwn(state.sessions, session.id)
        ? state.sessions[session.id]
        : EMPTY_SESSION_PREVIEW_STATE
      ).activeKey !== null
  )
  const artifactKeys = useMemo(
    () => collectWorkspaceArtifacts(getVisibleMessages(session)).map((a) => a.key),
    [session]
  )
  const showPreviewToggle = previewOpen || artifactKeys.length > 0 || hasOpenPreview
  const title = sessionTitle(session, t('untitledChat'), locale)
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
          {showPreviewToggle || isDesktopApp ? (
            <div className={styles.headerActions}>
              {showPreviewToggle ? (
                <IconButton
                  size="m"
                  tone="primary"
                  className={clsx(previewOpen && styles.browserButtonActive)}
                  icon={<IconBrowseOutline16 />}
                  tooltip={t(previewOpen ? 'previewClosePanel' : 'previewOpenPanel')}
                  tooltipPlacement="bottom"
                  aria-pressed={previewOpen}
                  onClick={() => togglePreviewPanel(session.id, artifactKeys)}
                />
              ) : null}
              {isDesktopApp ? (
                <IconButton
                  size="m"
                  tone="primary"
                  className={clsx(browserOpen && styles.browserButtonActive)}
                  icon={<IconGlobeLanguageOutline16 />}
                  tooltip={t(browserOpen ? 'closeBrowser' : 'openBrowser')}
                  tooltipPlacement="bottom"
                  aria-pressed={browserOpen}
                  onClick={() => void toggleBrowserPanel(session.id)}
                />
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
            <ChatInput sessionId={session.id} />
            <div className={styles.caveat}>{t('contentCaveat')}</div>
          </div>
        }
      />
    </div>
  )
}
