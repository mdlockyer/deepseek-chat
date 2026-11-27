import { MarkdownTheme } from '@deepseek-chat/lib-markdown'
import { ToastViewport, UiProvider, usePresence } from '@deepseek-chat/lib-ui'
import type { SiderMode } from '@deepseek-chat/slice-conversations'
import { PANEL_DURATION_MS } from '@deepseek-chat/spine/design'
import { useLocale } from '@deepseek-chat/spine/i18n'
import clsx from 'clsx'
import { useEffect, useRef } from 'react'
import { AppErrorBoundary } from './AppErrorBoundary.js'
import styles from './App.module.css'
import { useTranslate } from './i18n/index.js'
import { RightPanel } from './rightPanel/RightPanel.js'
import { useAppRuntime } from './RuntimeContext.js'
import { SettingsDialog } from './settings/SettingsDialog.js'
import { useRuntimeTheme } from './theme.js'
import { useIsMobile, useMobileViewport, usePreventPageScroll } from './viewport.js'

/**
 * Pure App Shell component bound to the nearest `<AppRuntimeProvider>`.
 * Supports both full-window production rendering and embedded multi-instance rendering
 * (e.g. side-by-side instances in the dev SSA Workbench).
 */
export const App = ({ embedded = false }: { embedded?: boolean }) => {
  const runtime = useAppRuntime()
  const { browser, conversations, preferences } = runtime.slices
  const { ChatMain, ChatSaveBanner, MobileSider, Sider, SiderToolbar } = conversations

  const isMobile = useIsMobile() && !embedded
  const dark = useRuntimeTheme(preferences) === 'dark'
  const locale = useLocale()
  const t = useTranslate()
  const layoutState = runtime.layout.useStore()
  const siderMode: SiderMode = isMobile ? 'absent' : layoutState.mode
  // The toolbar fades out when the last chat is deleted; it keeps showing the mode it had.
  const lastToolbarModeRef = useRef<'collapsed' | 'expanded'>('collapsed')
  if (siderMode !== 'absent') {
    lastToolbarModeRef.current = siderMode
  }
  const frameRef = useMobileViewport(isMobile)
  const activeId = conversations.useActiveSessionId()
  const { mounted: showToolbar, exiting: toolbarExiting } = usePresence(
    siderMode !== 'absent',
    PANEL_DURATION_MS
  )

  usePreventPageScroll(isMobile && !embedded)

  useEffect(() => {
    if (embedded) {
      return
    }
    document.documentElement.lang = locale
    document.title = t('appName')
  }, [embedded, locale, t])

  conversations.useChatLifecycle()

  useEffect(() => (browser ? browser.start() : undefined), [browser])

  useEffect(() => {
    if (embedded) {
      return
    }
    const unlisten = runtime.onOpenSettingsShortcut
      ? runtime.onOpenSettingsShortcut(runtime.settingsDialog.openFromShortcut)
      : () => {}
    const onKeyDown = (event: KeyboardEvent) => {
      if (
        event.metaKey &&
        !event.ctrlKey &&
        !event.altKey &&
        !event.shiftKey &&
        event.key === ','
      ) {
        event.preventDefault()
        runtime.settingsDialog.openFromShortcut()
      }
    }
    window.addEventListener('keydown', onKeyDown)
    return () => {
      unlisten()
      window.removeEventListener('keydown', onKeyDown)
    }
  }, [embedded, runtime])

  return (
    <UiProvider notices={runtime.notices} overlay={runtime.overlays}>
      <MarkdownTheme dark={dark}>
        <div
          ref={embedded ? undefined : frameRef}
          data-app-shell
          className={clsx(
            styles.frame,
            runtime.platform === 'desktop' && !embedded && styles.desktop
          )}
        >
          {isMobile ? (
            <MobileSider />
          ) : (
            <>
              <Sider collapsed={siderMode !== 'expanded'} />
              {showToolbar ? (
                <SiderToolbar siderMode={lastToolbarModeRef.current} exiting={toolbarExiting} />
              ) : null}
            </>
          )}
          <main className={styles.main}>
            <ChatSaveBanner />
            <div className={styles.content}>
              <AppErrorBoundary resetKey={activeId}>
                <ChatMain siderMode={siderMode} />
              </AppErrorBoundary>
            </div>
          </main>
          <RightPanel />
        </div>
        <SettingsDialog />
        {embedded ? null : <ToastViewport />}
      </MarkdownTheme>
    </UiProvider>
  )
}
