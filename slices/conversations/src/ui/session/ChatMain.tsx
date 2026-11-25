import { Button, useIsMobile } from '@deepseek-chat/lib-ui'
import { useEffect } from 'react'
import { useConversations } from '../../context.js'
import { useTranslate } from '../../messages.js'
import type { ConversationsRuntime } from '../../runtime.js'
import type { SiderMode } from '../../views.js'
import styles from './ChatMain.module.css'
import { MobileHeader } from './MobileHeader.js'
import { SessionView } from './SessionView.js'
import { SettingsHeaderButton } from './SettingsHeaderButton.js'
import { Welcome } from './Welcome.js'

/** 保存失败时的提示条，可重试 */
export const ChatSaveBanner = () => {
  const t = useTranslate()
  const { useChatStore, retrySaveSessions } = useConversations()
  const saveError = useChatStore((state) => Object.values(state.sessionSaveErrors).some(Boolean))
  const importingHistory = useChatStore((state) => state.importingHistory)
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
export const createChatHooks = (runtime: ConversationsRuntime) => {
  const useChatLifecycle = () => {
    const isMobile = useIsMobile()
    const activeId = runtime.useChatStore((state) => state.activeId)
    const hasSessions = runtime.useChatStore((state) => state.sessions.length > 0)

    useEffect(() => runtime.uploads.onUploadNotice(runtime.showNotice), [])
    useEffect(() => runtime.bindChatPersistence(), [])
    useEffect(() => {
      runtime.closeMobileSider()
    }, [activeId, hasSessions, isMobile])
    useEffect(() => {
      void runtime.initChat()
    }, [])
  }

  const useActiveSessionId = () => runtime.useChatStore((state) => state.activeId)

  return { useChatLifecycle, useActiveSessionId }
}

/** 主区域：加载中/失败、会话页或欢迎页 */
export const ChatMain = ({ siderMode }: { siderMode: SiderMode }) => {
  const t = useTranslate()
  const isMobile = useIsMobile()
  const { useChatStore, initChat, selectSession } = useConversations()
  const ready = useChatStore((state) => state.ready)
  const initError = useChatStore((state) => state.initError)
  const session = useChatStore((state) =>
    state.activeId !== null && Object.hasOwn(state.sessionCache, state.activeId)
      ? state.sessionCache[state.activeId]
      : undefined
  )
  const sessionLoadError = useChatStore((state) =>
    state.activeId === null ? false : state.sessionLoadErrors[state.activeId] === true
  )
  const streaming = useChatStore((state) =>
    state.activeId === null ? false : Object.hasOwn(state.streaming, state.activeId)
  )
  const activeId = useChatStore((state) => state.activeId)

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
  return session ? (
    <SessionView session={session} streaming={streaming} siderMode={siderMode} />
  ) : (
    <Welcome siderMode={siderMode} />
  )
}
