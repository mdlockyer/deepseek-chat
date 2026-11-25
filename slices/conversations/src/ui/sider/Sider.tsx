import {
  Button,
  Dialog,
  IconButton,
  IconPanelLeftOutline16,
  IconSettingsOutline16,
  useHoverGlide,
  useOverlayLock,
  usePresence,
} from '@deepseek-chat/lib-ui'
import { PANEL_DURATION_MS } from '@deepseek-chat/spine/design'
import clsx from 'clsx'
import { useEffect, useMemo, useRef, useState } from 'react'
import { deps } from '../../env.js'
import { useTranslate, useTranslate as useConversationsTranslate } from '../../messages.js'
import { showNotice } from '../../notice.js'
import { groupSessions } from '../../sessionGroups.js'
import { newChat, removeSession, useChatStore } from '../../store.js'
import { type SessionSummary } from '../../types.js'
import { closeMobileSider, useMobileSider } from './mobileSiderState.js'
import { NewChatIcon } from './NewChatIcon.js'
import { SessionItem } from './SessionItem.js'
import styles from './Sider.module.css'

/** 展开的侧边栏：名称与收起按钮、开启新对话、按时间分组的会话列表、底部设置；移动端放在抽屉里，收起按钮关闭抽屉 */
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
  const sessions = useChatStore((state) => state.sessions)
  const activeId = useChatStore((state) => state.activeId)
  const [now, setNow] = useState(Date.now)
  const tc = useConversationsTranslate()
  const groups = useMemo(() => groupSessions(sessions, now, tc), [sessions, now, tc])
  const [deleting, setDeleting] = useState<SessionSummary | null>(null)
  // 退场淡出期间 deleting 已清空，保留最后一条供确认弹窗播放退场
  const lastDeletingRef = useRef(deleting)
  if (deleting) {
    lastDeletingRef.current = deleting
  }
  const shownDeleting = deleting ?? lastDeletingRef.current
  const [deletePending, setDeletePending] = useState(false)
  const hoverGlide = useHoverGlide<HTMLDivElement>({ disabled: collapsed })

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

  // 无 scroll-driven animations 时用哨兵监听底部是否还有可滚动内容，驱动 --sider-fade-end
  useEffect(() => {
    const scroller = hoverGlide.containerRef.current
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
  }, [hoverGlide.containerRef])

  // 首屏列表逐条落入的 stagger 上限 8 条；移动端抽屉里不 stagger，随抽屉一起落
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
            onClick={() => (mobile ? closeMobileSider() : deps().ui.setSiderCollapsed(true))}
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
          <div className={styles.list} {...hoverGlide.containerProps}>
            <div {...hoverGlide.indicatorProps} />
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
          </div>
        </div>
        <div className={styles.bottom}>
          <button
            type="button"
            className={styles.settings}
            onClick={() => deps().ui.openSettings('general')}
          >
            <span className={styles.settingsIcon}>
              <IconSettingsOutline16 />
            </span>
            <span className={styles.settingsLabel}>{t('settings')}</span>
          </button>
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

/** 移动端抽屉：浮在页面上方，点空白区域关闭；滑入滑出与遮罩淡入淡出 */
export const MobileSider = () => {
  const open = useMobileSider((state) => state.open)
  const { mounted, exiting } = usePresence(open, PANEL_DURATION_MS)
  useOverlayLock(mounted)
  if (!mounted) {
    return null
  }
  return (
    <>
      <div
        className={clsx(styles.drawerMask, exiting && styles.exiting)}
        onClick={closeMobileSider}
      />
      <div className={clsx(styles.drawer, exiting && styles.exiting)}>
        <Sider mobile />
      </div>
    </>
  )
}
