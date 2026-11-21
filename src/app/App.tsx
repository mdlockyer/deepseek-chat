import { useLocale } from '@deepseek-chat/spine/i18n'
import { useEffect } from 'react'
import clsx from 'clsx'
import { translate, useTranslate } from '../i18n/index.js'
import { useSettings } from '../services/settings.js'
import { useIsMobile, useMobileViewport, usePreventPageScroll } from './viewport.js'
import {
  bindChatPersistence,
  initChat,
  retrySaveSessions,
  selectSession,
  useChatStore,
} from '../services/chat/store.js'
import { RightPanel } from '../components/sidePanel/RightPanel.js'
import { closeSearchPanel } from '../components/search/searchPanelState.js'
import { bindBrowserEvents, setActiveBrowserSession } from '../services/browser/state.js'
import { SessionView } from '../components/session/SessionView.js'
import { MobileHeader } from '../components/session/MobileHeader.js'
import { Welcome } from '../components/session/Welcome.js'
import {
  ensureApiKey,
  openSettingsFromShortcut,
} from '../components/settings/settingsDialogState.js'
import { SettingsDialog } from '../components/settings/SettingsDialog.js'
import { Toast } from '@deepseek-chat/spine/design'
import { showToast } from '../components/base/toastState.js'
import { onUploadNotice } from '../services/attachments.js'
import { Button } from '@deepseek-chat/spine/design'
import { voice } from './composition.js'
import { isDesktopApp, onOpenSettings } from '../platform/desktop.js'
import { usePresence, PANEL_DURATION_MS } from '@deepseek-chat/spine/design'
import { CollapsedSider } from '../components/sider/CollapsedSider.js'
import { closeMobileSider } from '../components/sider/mobileSiderState.js'
import { MobileSider, Sider } from '../components/sider/Sider.js'
import { AppErrorBoundary } from './AppErrorBoundary.js'
import styles from './App.module.css'

export const App = () => {
  const t = useTranslate()
  const isMobile = useIsMobile()
  const locale = useLocale()
  const desktopSettingsReady = useSettings((state) => state.desktopSettingsReady)
  // 移动端侧边栏以独立抽屉管理开合状态
  const siderCollapsed = useSettings((state) => state.siderCollapsed) && !isMobile
  const ready = useChatStore((state) => state.ready)
  const initError = useChatStore((state) => state.initError)
  const saveError = useChatStore((state) => Object.values(state.sessionSaveErrors).some(Boolean))
  const importingHistory = useChatStore((state) => state.importingHistory)
  const session = useChatStore((state) =>
    state.activeId !== null && Object.hasOwn(state.sessionCache, state.activeId)
      ? state.sessionCache[state.activeId]
      : undefined
  )
  const sessionLoadError = useChatStore((state) =>
    state.activeId === null ? false : state.sessionLoadErrors[state.activeId] === true
  )
  const frameRef = useMobileViewport(isMobile)
  const streaming = useChatStore((state) =>
    state.activeId === null ? false : Object.hasOwn(state.streaming, state.activeId)
  )
  const activeId = useChatStore((state) => state.activeId)
  // 收起后的按钮组退场淡出期间保持挂载
  const { mounted: showCollapsedSider, exiting: collapsedSiderExiting } = usePresence(
    siderCollapsed,
    PANEL_DURATION_MS
  )

  usePreventPageScroll(isMobile)

  useEffect(() => {
    document.documentElement.lang = locale
    document.title = translate('appName')
  }, [locale])

  // 文件数、存储空间达到上限时，附件上只显示「上传失败」，原因用 toast 说明
  useEffect(() => onUploadNotice(showToast), [])
  useEffect(bindChatPersistence, [])
  useEffect(bindBrowserEvents, [])

  // 搜索结果面板只属于当前会话
  useEffect(closeSearchPanel, [activeId])
  // 浏览器面板标签页绑定到当前会话
  useEffect(() => {
    setActiveBrowserSession(activeId)
  }, [activeId])
  // 切换会话时停止朗读
  useEffect(() => voice.readAloud.stop(), [activeId])
  // 移动端选中会话、切换布局后收起抽屉
  useEffect(closeMobileSider, [activeId, isMobile])

  useEffect(() => {
    void initChat()
  }, [])

  // 桌面版须等原生配置加载完成后再检查 API Key，避免超时先渲染时误弹设置窗口
  useEffect(() => {
    if (desktopSettingsReady) {
      ensureApiKey()
    }
  }, [desktopSettingsReady])

  // macOS Cmd+, 打开设置（菜单栏触发 + webview 键盘兜底）
  useEffect(() => {
    const unlisten = onOpenSettings(openSettingsFromShortcut)
    const onKeyDown = (event: KeyboardEvent) => {
      if (
        event.metaKey &&
        !event.ctrlKey &&
        !event.altKey &&
        !event.shiftKey &&
        event.key === ','
      ) {
        event.preventDefault()
        openSettingsFromShortcut()
      }
    }
    window.addEventListener('keydown', onKeyDown)
    return () => {
      unlisten()
      window.removeEventListener('keydown', onKeyDown)
    }
  }, [])

  return (
    <>
      <div ref={frameRef} className={clsx(styles.frame, isDesktopApp && styles.desktop)}>
        {isMobile ? (
          <MobileSider />
        ) : (
          <>
            <Sider
              collapsed={siderCollapsed}
              controlsHidden={siderCollapsed}
              controlsLanding={collapsedSiderExiting}
            />
            {showCollapsedSider ? <CollapsedSider exiting={collapsedSiderExiting} /> : null}
          </>
        )}
        <main className={styles.main}>
          {saveError ? (
            <div className={styles.saveError} role="alert">
              <span>{t('sessionSaveFailed')}</span>
              <Button
                variant="outlined"
                size="s"
                disabled={importingHistory}
                onClick={retrySaveSessions}
              >
                {t('retry')}
              </Button>
            </div>
          ) : null}
          <div className={styles.content}>
            <AppErrorBoundary resetKey={activeId}>
              {!ready || (activeId !== null && !session) ? (
                <div className={styles.loadingView}>
                  {isMobile ? <MobileHeader /> : null}
                  <div className={styles.loadingState} role="status" aria-live="polite">
                    <span>
                      {(!ready ? initError : sessionLoadError)
                        ? t(!ready ? 'sessionListLoadFailed' : 'sessionLoadFailed')
                        : t('sessionLoading')}
                    </span>
                    {(!ready ? initError : sessionLoadError) ? (
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
              ) : session ? (
                <SessionView
                  session={session}
                  streaming={streaming}
                  siderCollapsed={siderCollapsed}
                />
              ) : (
                <Welcome siderCollapsed={siderCollapsed} />
              )}
            </AppErrorBoundary>
          </div>
        </main>
        <RightPanel />
      </div>
      <SettingsDialog />
      <Toast />
    </>
  )
}
