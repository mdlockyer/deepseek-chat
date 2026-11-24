import { MarkdownTheme } from '@deepseek-chat/lib-markdown'
import { ToastViewport, UiProvider } from '@deepseek-chat/lib-ui'
import { Toast, usePresence, PANEL_DURATION_MS } from '@deepseek-chat/spine/design'
import { useLocale } from '@deepseek-chat/spine/i18n'
import { useEffect } from 'react'
import clsx from 'clsx'
import { translate } from './i18n/index.js'
import { useLayout } from './layout.js'
import { useTheme } from './theme.js'
import { useIsMobile, useMobileViewport, usePreventPageScroll } from './viewport.js'
import { RightPanel } from './rightPanel/RightPanel.js'
import { ensureApiKey, openSettingsFromShortcut } from './settings/settingsDialogState.js'
import { SettingsDialog } from './settings/SettingsDialog.js'
import { account, browser, notices, overlays } from './composition.js'
import { conversations } from './conversations.js'
import { isDesktopApp, onOpenSettings } from './platform/desktop.js'
import { AppErrorBoundary } from './AppErrorBoundary.js'
import styles from './App.module.css'

const { ChatMain, ChatSaveBanner, CollapsedSider, MobileSider, Sider } = conversations

export const App = () => {
  const isMobile = useIsMobile()
  const dark = useTheme() === 'dark'
  const locale = useLocale()
  const desktopSettingsReady = account.useState().status === 'ready'
  // 移动端侧边栏以独立抽屉管理开合状态
  const siderCollapsed = useLayout((state) => state.siderCollapsed) && !isMobile
  const frameRef = useMobileViewport(isMobile)
  const activeId = conversations.useActiveSessionId()
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

  conversations.useChatLifecycle()
  useEffect(() => browser.start(), [])

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
    <UiProvider notices={notices} overlay={overlays}>
      <MarkdownTheme dark={dark}>
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
            <ChatSaveBanner />
            <div className={styles.content}>
              <AppErrorBoundary resetKey={activeId}>
                <ChatMain siderCollapsed={siderCollapsed} />
              </AppErrorBoundary>
            </div>
          </main>
          <RightPanel />
        </div>
        <SettingsDialog />
        <Toast />
        <ToastViewport />
      </MarkdownTheme>
    </UiProvider>
  )
}
