import { IconButton, IconPanelLeftOutline16 } from '@deepseek-chat/lib-ui'
import { PANEL_DURATION_MS } from '@deepseek-chat/spine/design'
import clsx from 'clsx'
import { useLayoutEffect, useRef } from 'react'
import { useConversations } from '../../context.js'
import { useTranslate } from '../../messages.js'
import { NewChatIcon } from './NewChatIcon.js'
import styles from './Sider.module.css'

const TOGGLE_SELECTOR = '[data-sider-toggle]'
const COLLAPSED_PILL_WIDTH = 78
const SINGLE_BUTTON_WIDTH = 40

/**
 * 收起后标题行上的按钮组：沿顶栏水平滑至交通灯右侧并顺滑展开为 78px 胶囊。
 */
export const CollapsedSider = ({ exiting = false }: { exiting?: boolean }) => {
  const t = useTranslate()
  const { deps, newChat } = useConversations()
  const groupRef = useRef<HTMLDivElement | null>(null)
  const toggleRef = useRef<HTMLSpanElement | null>(null)
  const wasMountedRef = useRef(false)

  useLayoutEffect(() => {
    const isFreshMount = !wasMountedRef.current
    wasMountedRef.current = true

    const group = groupRef.current
    const toggle = toggleRef.current
    const sider =
      group?.closest('[data-app-shell]')?.querySelector<HTMLElement>('[data-sider-root]') ??
      document.querySelector<HTMLElement>('[data-sider-root]')
    const source = sider?.querySelector<HTMLElement>(TOGGLE_SELECTOR)
    if (!sider || !group || !toggle || !source) {
      return
    }
    if (isFreshMount && !exiting && getComputedStyle(sider).visibility !== 'visible') {
      group.classList.add(styles.collapsedStatic)
      return
    }
    if (window.matchMedia('(prefers-reduced-motion: reduce)').matches) {
      return
    }

    const computed = getComputedStyle(group)
    const currentTransform = computed.transform
    const currentWidth = computed.width

    group.style.transition = 'none'
    group.style.transform = 'none'
    group.style.width = `${COLLAPSED_PILL_WIDTH}px`
    const from = source.getBoundingClientRect()
    const to = toggle.getBoundingClientRect()
    const dx = from.left + from.width / 2 - (to.left + to.width / 2)

    if (!exiting) {
      group.style.transform = isFreshMount
        ? `translateX(${dx}px)`
        : currentTransform === 'none'
          ? 'translateX(0)'
          : currentTransform
      group.style.width = isFreshMount ? `${SINGLE_BUTTON_WIDTH}px` : currentWidth
      void group.offsetWidth
      group.style.transition = `transform ${PANEL_DURATION_MS}ms var(--ui-ease-panel), width ${PANEL_DURATION_MS}ms var(--ui-ease-panel)`
      group.style.transform = 'translateX(0)'
      group.style.width = `${COLLAPSED_PILL_WIDTH}px`
    } else {
      group.classList.remove(styles.collapsedStatic)
      group.style.transform = currentTransform === 'none' ? 'translateX(0)' : currentTransform
      group.style.width = currentWidth
      void group.offsetWidth
      group.style.transition = `transform ${PANEL_DURATION_MS}ms var(--ui-ease-panel), width 180ms var(--ui-ease-panel)`
      group.style.transform = `translateX(${dx}px)`
      group.style.width = `${SINGLE_BUTTON_WIDTH}px`
    }
  }, [exiting])

  return (
    <div
      className={clsx(styles.collapsed, exiting && styles.collapsedExiting)}
      data-tauri-drag-region="deep"
    >
      <div ref={groupRef} className={styles.collapsedGroup}>
        <span ref={toggleRef} className={styles.toggleSlot}>
          <IconButton
            size="m"
            tone="primary"
            icon={<IconPanelLeftOutline16 />}
            tooltip={t('expandSiderbarButton')}
            tooltipPlacement="bottom"
            tooltipDisabled={exiting}
            onClick={() => deps.ui.setSiderCollapsed(false)}
          />
        </span>
        <span className={styles.newChatSlot}>
          <IconButton
            size="m"
            tone="primary"
            icon={<NewChatIcon />}
            tooltip={t('newChat')}
            tooltipPlacement="bottom"
            tooltipDisabled={exiting}
            onClick={newChat}
          />
        </span>
      </div>
    </div>
  )
}
