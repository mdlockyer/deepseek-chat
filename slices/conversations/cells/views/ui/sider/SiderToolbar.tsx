import { IconButton, IconPanelLeftOutline16 } from '@deepseek-chat/lib-ui'
import clsx from 'clsx'
import { useEffect, useRef, useState } from 'react'
import { useTranslate } from '../../../../kernel/index.js'
import { useConversations } from '../../context.js'
import { NewChatIcon } from './NewChatIcon.js'
import styles from './Sider.module.css'

/**
 * Desktop sidebar toggle. A single button that travels with the sidebar: at the sidebar's right
 * edge while it is open, and beside the traffic lights (in a pill with "+") while it is
 * collapsed. Because it is one element moving on the panel's curve, there is no hand-off between
 * two buttons. The "+" shows only while collapsed; when the sidebar is open its own "New chat"
 * button sits right below.
 */
export const SiderToolbar = ({
  siderMode,
  exiting = false,
  onSetCollapsed,
}: {
  siderMode: 'collapsed' | 'expanded'
  exiting?: boolean
  onSetCollapsed?: (collapsed: boolean) => void
}) => {
  const t = useTranslate()
  const { newChat } = useConversations()
  const expanded = siderMode === 'expanded'
  const toolbarRef = useRef<HTMLDivElement | null>(null)
  const [moving, setMoving] = useState(false)

  useEffect(() => {
    const toolbar = toolbarRef.current
    if (!toolbar) {
      return
    }
    const isSlide = (event: TransitionEvent) =>
      event.target === toolbar && event.propertyName === 'transform'
    const onRun = (event: TransitionEvent) => isSlide(event) && setMoving(true)
    const onDone = (event: TransitionEvent) => isSlide(event) && setMoving(false)
    toolbar.addEventListener('transitionrun', onRun)
    toolbar.addEventListener('transitionend', onDone)
    toolbar.addEventListener('transitioncancel', onDone)
    return () => {
      toolbar.removeEventListener('transitionrun', onRun)
      toolbar.removeEventListener('transitionend', onDone)
      toolbar.removeEventListener('transitioncancel', onDone)
    }
  }, [])

  return (
    <div
      ref={toolbarRef}
      className={clsx(
        styles.toolbar,
        expanded && styles.toolbarExpanded,
        moving && styles.toolbarMoving,
        exiting && styles.toolbarExiting
      )}
      data-tauri-drag-region="deep"
    >
      <IconButton
        size="m"
        tone={expanded ? 'tertiary' : 'primary'}
        icon={<IconPanelLeftOutline16 />}
        tooltip={t(expanded ? 'collapseSiderbarButton' : 'expandSiderbarButton')}
        tooltipPlacement="bottom"
        tooltipDisabled={exiting}
        aria-expanded={expanded}
        onClick={() => onSetCollapsed?.(expanded)}
      />
      <span className={styles.toolbarNewChat} aria-hidden={expanded || undefined}>
        <IconButton
          size="m"
          tone="primary"
          icon={<NewChatIcon />}
          tooltip={t('newChat')}
          tooltipPlacement="bottom"
          tooltipDisabled={expanded || exiting}
          tabIndex={expanded ? -1 : undefined}
          onClick={newChat}
        />
      </span>
    </div>
  )
}
