import clsx from 'clsx'
import { useEffect, useMemo, useRef, useState } from 'react'
import { useTranslate } from '../../i18n/index.js'
import { acquireOverlay } from '@deepseek-chat/spine/design'
import {
  IconPanelLeftOutline16,
  IconSettingsOutline16,
  NewChatIcon,
} from '@deepseek-chat/spine/design'
import { setSiderCollapsed } from '../../app/layout.js'
import { groupSessions } from '../../services/chat/sessionGroups.js'
import { newChat, removeSession, useChatStore } from '../../services/chat/store.js'
import type { SessionSummary } from '../../services/chat/types.js'
import { Button } from '@deepseek-chat/spine/design'
import { IconButton } from '@deepseek-chat/spine/design'
import { Modal } from '@deepseek-chat/spine/design'
import { showToast } from '../base/toastState.js'
import { openSettings } from '../settings/settingsDialogState.js'
import { closeMobileSider, useMobileSider } from './mobileSiderState.js'
import { PANEL_DURATION_MS, usePresence } from '@deepseek-chat/spine/design'
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
  const groups = useMemo(() => groupSessions(sessions, now, t), [sessions, now, t])
  const [deleting, setDeleting] = useState<SessionSummary | null>(null)
  // 退场淡出期间 deleting 已清空，保留最后一条供确认弹窗播放退场
  const lastDeletingRef = useRef(deleting)
  if (deleting) {
    lastDeletingRef.current = deleting
  }
  const deleteModal = usePresence(deleting !== null, 160)
  const shownDeleting = deleting ?? lastDeletingRef.current
  const [deletePending, setDeletePending] = useState(false)

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
            onClick={() => (mobile ? closeMobileSider() : setSiderCollapsed(true))}
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
          <ul className={styles.list}>
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
        <div className={styles.bottom}>
          <button type="button" className={styles.settings} onClick={() => openSettings('general')}>
            <span className={styles.settingsIcon}>
              <IconSettingsOutline16 />
            </span>
            <span className={styles.settingsLabel}>{t('settings')}</span>
          </button>
        </div>
      </div>
      {deleteModal.mounted && shownDeleting ? (
        <Modal
          title={t('deleteSessionModalContentTitle')}
          exiting={deleteModal.exiting}
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
                disabled={deletePending}
                onClick={async () => {
                  setDeletePending(true)
                  try {
                    if (await removeSession(shownDeleting.id)) {
                      setDeleting(null)
                    } else {
                      showToast({ key: 'sessionDeleteFailed', type: 'error' })
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
        </Modal>
      ) : null}
    </div>
  )
}

/** 移动端抽屉：浮在页面上方，点空白区域关闭；滑入滑出与遮罩淡入淡出 */
export const MobileSider = () => {
  const open = useMobileSider((state) => state.open)
  const { mounted, exiting } = usePresence(open, PANEL_DURATION_MS)
  useEffect(() => (mounted ? acquireOverlay() : undefined), [mounted])
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
