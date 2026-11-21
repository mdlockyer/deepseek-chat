import clsx from 'clsx'
import { useLayoutEffect, useRef } from 'react'
import { IconPanelLeftOutline16, NewChatIcon } from '@deepseek-chat/spine/design'
import { useTranslate } from '../../i18n/index.js'
import { setSiderCollapsed } from '../../services/settings.js'
import { newChat } from '../../services/chat/store.js'
import { IconButton } from '@deepseek-chat/spine/design'
import { PANEL_DURATION_MS } from '@deepseek-chat/spine/design'
import styles from './Sider.module.css'

const TOGGLE_SELECTOR = '[data-sider-toggle]'
const COLLAPSED_PILL_WIDTH = 78
const SINGLE_BUTTON_WIDTH = 40

/**
 * 收起后标题行上的按钮组：
 * 收起时从侧边栏右上角切换按钮的 40×40 圆形位置出发，沿顶栏水平滑至交通灯右侧并顺滑展开为 78px 胶囊，
 * 新对话按钮从右侧胶囊内轻柔显露；展开时先收拢为 40×40 圆形再随侧边栏右缘滑回并无缝交接。
 */
export const CollapsedSider = ({ exiting = false }: { exiting?: boolean }) => {
  const t = useTranslate()
  const groupRef = useRef<HTMLDivElement | null>(null)
  const toggleRef = useRef<HTMLSpanElement | null>(null)
  const wasMountedRef = useRef(false)

  useLayoutEffect(() => {
    const isFreshMount = !wasMountedRef.current
    wasMountedRef.current = true

    const sider = document.querySelector<HTMLElement>('[data-sider-root]')
    const group = groupRef.current
    const toggle = toggleRef.current
    const source = sider?.querySelector<HTMLElement>(TOGGLE_SELECTOR)
    if (!sider || !group || !toggle || !source) {
      return
    }
    // 首屏即处于收起状态时无需播放从侧边栏滑出的入场动画
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

    // 临时重置到终态尺寸与位置，测量收起按钮与展开按钮之间的精确水平位移
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
      group.style.transition = `transform ${PANEL_DURATION_MS}ms var(--ds-ease-panel), width ${PANEL_DURATION_MS}ms var(--ds-ease-panel)`
      group.style.transform = 'translateX(0)'
      group.style.width = `${COLLAPSED_PILL_WIDTH}px`
    } else {
      group.classList.remove(styles.collapsedStatic)
      group.style.transform = currentTransform === 'none' ? 'translateX(0)' : currentTransform
      group.style.width = currentWidth
      void group.offsetWidth
      group.style.transition = `transform ${PANEL_DURATION_MS}ms var(--ds-ease-panel), width 180ms var(--ds-ease-panel)`
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
            onClick={() => setSiderCollapsed(false)}
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
