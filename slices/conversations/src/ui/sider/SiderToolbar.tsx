import { IconButton, IconPanelLeftOutline16 } from '@deepseek-chat/lib-ui'
import clsx from 'clsx'
import { useConversations } from '../../context.js'
import { useTranslate } from '../../messages.js'
import { NewChatIcon } from './NewChatIcon.js'
import styles from './Sider.module.css'

/**
 * Desktop sidebar toolbar, pinned after the traffic lights in both the expanded and collapsed
 * states. The sidebar slides underneath it, so the toggle the user clicks never moves. The "+"
 * shows only while the sidebar is collapsed; when it is open the sidebar's own "New chat"
 * button sits right below.
 */
export const SiderToolbar = ({
  siderMode,
  exiting = false,
}: {
  siderMode: 'collapsed' | 'expanded'
  exiting?: boolean
}) => {
  const t = useTranslate()
  const { deps, newChat } = useConversations()
  const expanded = siderMode === 'expanded'

  return (
    <div
      className={clsx(
        styles.toolbar,
        expanded && styles.toolbarExpanded,
        exiting && styles.toolbarExiting
      )}
      data-tauri-drag-region="deep"
    >
      <IconButton
        size="m"
        tone="primary"
        icon={<IconPanelLeftOutline16 />}
        tooltip={t(expanded ? 'collapseSiderbarButton' : 'expandSiderbarButton')}
        tooltipPlacement="bottom"
        tooltipDisabled={exiting}
        aria-expanded={expanded}
        onClick={() => deps.ui.setSiderCollapsed(expanded)}
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
