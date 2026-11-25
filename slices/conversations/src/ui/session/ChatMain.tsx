import { Button, useIsMobile } from '@deepseek-chat/lib-ui'
import { useEffect } from 'react'
import { onUploadNotice } from '../../attachments.js'
import { deps } from '../../env.js'
import { useTranslate } from '../../messages.js'
import { showNotice } from '../../notice.js'
import {
  bindChatPersistence,
  initChat,
  retrySaveSessions,
  selectSession,
  useChatStore,
} from '../../store.js'
import { closeActivityPanel } from '../activity/activityPanelState.js'
import { closeMobileSider } from '../sider/mobileSiderState.js'
import styles from './ChatMain.module.css'
import { MobileHeader } from './MobileHeader.js'
import { SessionView } from './SessionView.js'
import { Welcome } from './Welcome.js'

/** 保存失败时的提示条，可重试 */
export const ChatSaveBanner = () => {
  const t = useTranslate()
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

/**
 * 聊天的启动与随当前会话切换的清理。由应用在错误边界之外调用一次，内容区出错时仍保持运行。
 */
export const useChatLifecycle = () => {
  const isMobile = useIsMobile()
  const activeId = useChatStore((state) => state.activeId)

  // 文件数、存储空间达到上限时，附件上只显示「上传失败」，原因用 toast 说明
  useEffect(() => onUploadNotice(showNotice), [])
  useEffect(bindChatPersistence, [])
  // 活动与来源面板只属于当前会话
  useEffect(closeActivityPanel, [activeId])
  // 右侧面板（浏览器标签页等）绑定到当前会话
  useEffect(() => {
    deps().onActiveSessionChange(activeId)
  }, [activeId])
  // 切换会话时停止朗读
  useEffect(() => deps().ui.voice.stopReadAloud(), [activeId])
  // 移动端选中会话、切换布局后收起抽屉
  useEffect(closeMobileSider, [activeId, isMobile])
  useEffect(() => {
    void initChat()
  }, [])
}

/** 当前会话 ID（null 为新对话页） */
export const useActiveSessionId = () => useChatStore((state) => state.activeId)

/** 主区域：加载中/失败、会话页或欢迎页 */
export const ChatMain = ({ siderCollapsed }: { siderCollapsed: boolean }) => {
  const t = useTranslate()
  const isMobile = useIsMobile()
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
        {isMobile ? <MobileHeader /> : null}
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
    <SessionView session={session} streaming={streaming} siderCollapsed={siderCollapsed} />
  ) : (
    <Welcome siderCollapsed={siderCollapsed} />
  )
}
