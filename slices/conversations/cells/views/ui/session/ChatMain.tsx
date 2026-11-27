import { Button, useIsMobile } from '@deepseek-chat/lib-ui'
import { useEffect } from 'react'
import {
  getCachedSession,
  hasAnySaveError,
  hasInitError,
  hasLoadError,
  isHistoryReady,
  isHistoryReplacing,
  isSessionCompacting,
  isSessionStreaming,
  useTranslate,
} from '../../../../kernel/index.js'
import { useConversations, type ConversationsViewRuntime } from '../../context.js'
import type { SiderMode } from '../../views.js'
import styles from './ChatMain.module.css'
import { ChatStage } from './ChatStage.js'
import { MobileHeader } from './MobileHeader.js'
import { SettingsHeaderButton } from './SettingsHeaderButton.js'

/** 保存失败时的提示条，可重试 */
export const ChatSaveBanner = () => {
  const t = useTranslate()
  const { useChatState, retrySaveSessions } = useConversations()
  const saveError = useChatState(hasAnySaveError)
  const importingHistory = useChatState(isHistoryReplacing)
  return saveError ? (
    <div className={styles.saveError} role="alert">
      <span>{t('sessionSaveFailed')}</span>
      <Button variant="outlined" size="s" disabled={importingHistory} onClick={retrySaveSessions}>
        {t('retry')}
      </Button>
    </div>
  ) : null
}

/** Factory-bound lifecycle hooks for a specific conversations slice instance. */
export const createChatHooks = (runtime: ConversationsViewRuntime) => {
  const useChatLifecycle = () => {
    const isMobile = useIsMobile()
    const activeId = runtime.useChatState((state) => state.activeId)
    const hasSessions = runtime.useChatState((state) => state.sessions.length > 0)

    useEffect(() => runtime.uploads.onUploadNotice(runtime.showNotice), [])
    useEffect(() => runtime.bindChatPersistence(), [])
    useEffect(() => {
      runtime.closeMobileSider()
    }, [activeId, hasSessions, isMobile])
    useEffect(() => {
      void runtime.initChat()
    }, [])
  }

  const useActiveSessionId = () => runtime.useChatState((state) => state.activeId)

  return { useChatLifecycle, useActiveSessionId }
}

/** 主区域：加载中/失败、会话页或欢迎页 */
export const ChatMain = ({ siderMode }: { siderMode: SiderMode }) => {
  const t = useTranslate()
  const isMobile = useIsMobile()
  const { useChatState, initChat, selectSession } = useConversations()
  const ready = useChatState(isHistoryReady)
  const initError = useChatState(hasInitError)
  const session = useChatState((state) => getCachedSession(state, state.activeId))
  const sessionLoadError = useChatState((state) => hasLoadError(state, state.activeId))
  const streaming = useChatState((state) => isSessionStreaming(state, state.activeId))
  const compacting = useChatState((state) => isSessionCompacting(state, state.activeId))
  const activeId = useChatState((state) => state.activeId)

  if (!ready || (activeId !== null && !session)) {
    const failed = !ready ? initError : sessionLoadError
    return (
      <div className={styles.loadingView}>
        {isMobile ? (
          <MobileHeader />
        ) : (
          <div className={styles.loadingHeader} data-tauri-drag-region>
            <SettingsHeaderButton />
          </div>
        )}
        <div className={styles.loadingState} role="status" aria-live="polite">
          <span>
            {failed
              ? t(!ready ? 'sessionListLoadFailed' : 'sessionLoadFailed')
              : t('sessionLoading')}
          </span>
          {failed ? (
            <Button
              variant="outlined"
              size="m"
              onClick={() => {
                if (!ready) {
                  void initChat()
                } else if (activeId !== null) {
                  selectSession(activeId)
                }
              }}
            >
              {t('retry')}
            </Button>
          ) : null}
        </div>
      </div>
    )
  }
  return (
    <ChatStage
      session={session}
      streaming={streaming}
      compacting={compacting}
      siderMode={siderMode}
    />
  )
}
