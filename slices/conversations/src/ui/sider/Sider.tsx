import {
  Button,
  Dialog,
  HoverGlide,
  IconButton,
  IconPanelLeftOutline16,
  useOverlayLock,
  usePresence,
} from '@deepseek-chat/lib-ui'
import { PANEL_DURATION_MS } from '@deepseek-chat/spine/design'
import clsx from 'clsx'
import { useEffect, useMemo, useRef, useState } from 'react'
import { useConversations } from '../../context.js'
import { useTranslate, useTranslate as useConversationsTranslate } from '../../messages.js'
import { groupSessions } from '../../sessionGroups.js'
import { type SessionSummary } from '../../types.js'
import { NewChatIcon } from './NewChatIcon.js'
import { SessionItem } from './SessionItem.js'
import styles from './Sider.module.css'

/** 展开的侧边栏：收起按钮、开启新对话、按时间分组的会话列表；移动端放在抽屉里，收起按钮关闭抽屉 */
export const Sider = ({
  mobile = false,
  collapsed = false,
  controlsHidden = false,
  controlsLanding = false,
}: {
  mobile?: boolean
  collapsed?: boolean
  controlsHidden?: boolean
  controlsLanding?: boolean
}) => {
  const t = useTranslate()
  const tc = useConversationsTranslate()
  const { deps, useChatStore, newChat, removeSession, closeMobileSider, showNotice } =
    useConversations()
  const sessions = useChatStore((state) => state.sessions)
  const activeId = useChatStore((state) => state.activeId)
  const [now, setNow] = useState(Date.now)
  const groups = useMemo(() => groupSessions(sessions, now, tc), [sessions, now, tc])
  const [deleting, setDeleting] = useState<SessionSummary | null>(null)
  const lastDeletingRef = useRef(deleting)
  if (deleting) {
    lastDeletingRef.current = deleting
  }
  const shownDeleting = deleting ?? lastDeletingRef.current
  const [deletePending, setDeletePending] = useState(false)
  const listRef = useRef<HTMLDivElement | null>(null)

  useEffect(() => {
    let timer: ReturnType<typeof setTimeout>
    const refresh = () => {
      clearTimeout(timer)
      const time = Date.now()
      setNow(time)
      const midnight = new Date(time).setHours(24, 0, 0, 0)
      timer = setTimeout(refresh, midnight - time)
    }
    const onVisibilityChange = () => {
      if (document.visibilityState === 'visible') {
        refresh()
      }
    }
    refresh()
    document.addEventListener('visibilitychange', onVisibilityChange)
    window.addEventListener('focus', refresh)
    return () => {
      clearTimeout(timer)
      document.removeEventListener('visibilitychange', onVisibilityChange)
      window.removeEventListener('focus', refresh)
    }
  }, [])

  useEffect(() => {
    const scroller = listRef.current
    if (
      !scroller ||
      typeof CSS === 'undefined' ||
      CSS.supports('animation-timeline', 'scroll(self block)') ||
      typeof IntersectionObserver === 'undefined'
    ) {
      return
    }
    const sentinel = document.createElement('div')
    sentinel.setAttribute('aria-hidden', 'true')
    sentinel.className = styles.listEndSentinel
    scroller.append(sentinel)
    const observer = new IntersectionObserver(
      (entries) => {
        const entry = entries.at(-1)
        if (entry) {
          scroller.classList.toggle(styles.listMoreEnd, !entry.isIntersecting)
        }
      },
      { root: scroller, rootMargin: '1px' }
    )
    observer.observe(sentinel)
    return () => {
      observer.disconnect()
      sentinel.remove()
      scroller.classList.remove(styles.listMoreEnd)
    }
  }, [])

  let enterIndex = 0

  return (
    <div
      className={clsx(
        styles.sider,
        mobile && styles.mobile,
        collapsed && styles.collapsedSider,
        controlsHidden && styles.controlsHidden,
        controlsLanding && styles.controlsLanding
      )}
      aria-hidden={collapsed || undefined}
      data-sider-root
    >
      <div className={styles.siderInner}>
        <div className={styles.top} data-tauri-drag-region>
          <IconButton
            size="m"
            icon={<IconPanelLeftOutline16 />}
            tooltip={t('collapseSiderbarButton')}
            tooltipPlacement="bottom"
            tooltipDisabled={controlsHidden}
            data-sider-toggle
            onClick={() => (mobile ? closeMobileSider() : deps.ui.setSiderCollapsed(true))}
          />
        </div>
        <button
          type="button"
          className={styles.newChat}
          onClick={() => {
            newChat()
            closeMobileSider()
          }}
        >
          <span className={styles.newChatIcon}>
            <NewChatIcon />
          </span>
          {t('newChat')}
        </button>
        <div className={styles.listWrap}>
          <HoverGlide ref={listRef} className={styles.list} disabled={collapsed}>
            <ul className={styles.groups}>
              {groups.map((group) => (
                <li key={group.key} className={styles.section}>
                  <div className={styles.sectionHeader}>{group.label}</div>
                  <ul className={styles.sessions}>
                    {group.sessions.map((session) => (
                      <SessionItem
                        key={session.id}
                        session={session}
                        active={session.id === activeId}
                        enterDelay={mobile ? 0 : Math.min(enterIndex++, 8) * 24}
                        onDelete={() => setDeleting(session)}
                      />
                    ))}
                  </ul>
                </li>
              ))}
            </ul>
          </HoverGlide>
        </div>
      </div>
      <Dialog
        open={deleting !== null}
        title={t('deleteSessionModalContentTitle')}
        dismissible={!deletePending}
        onClose={() => {
          if (!deletePending) {
            setDeleting(null)
          }
        }}
        footer={
          <>
            <Button variant="outlined" disabled={deletePending} onClick={() => setDeleting(null)}>
              {t('cancel')}
            </Button>
            <Button
              variant="danger"
              loading={deletePending}
              disabled={deletePending}
              onClick={async () => {
                if (!shownDeleting) {
                  return
                }
                setDeletePending(true)
                try {
                  if (await removeSession(shownDeleting.id)) {
                    setDeleting(null)
                  } else {
                    showNotice({ key: 'sessionDeleteFailed', type: 'error' })
                  }
                } finally {
                  setDeletePending(false)
                }
              }}
            >
              {t('delete')}
            </Button>
          </>
        }
      >
        {t('deleteSessionWithFilesDescription')}
      </Dialog>
    </div>
  )
}

/** 移动端抽屉：常驻壳层以支持任意时刻平滑反向打断，与桌面左右面板共用统一曲线 */
export const MobileSider = () => {
  const { useMobileSider, closeMobileSider } = useConversations()
  const open = useMobileSider((state) => state.open)
  const { mounted } = usePresence(open, PANEL_DURATION_MS)
  useOverlayLock(mounted)
  return (
    <>
      <div
        aria-hidden={!open || undefined}
        className={clsx(styles.drawerMask, !open && styles.drawerMaskClosed)}
        onClick={closeMobileSider}
      />
      <div
        aria-hidden={!open || undefined}
        className={clsx(styles.drawer, !open && styles.drawerClosed)}
      >
        {mounted ? <Sider mobile /> : null}
      </div>
    </>
  )
}
