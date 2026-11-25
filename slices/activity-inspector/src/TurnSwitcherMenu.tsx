import { IconChevronDownOutline14, Menu } from '@deepseek-chat/lib-ui'
import clsx from 'clsx'
import { activityInspectorMessages } from './messages.js'
import type { SessionTurnSummary } from './types.js'
import styles from './ActivityPanel.module.css'

/** Compact header turn switcher (mirrors PreviewPanel's FileSwitcherMenu) shown only on multi-turn chats. */
export const TurnSwitcherMenu = ({
  turns,
  activeMessageId,
  onSelect,
}: {
  turns: readonly SessionTurnSummary[]
  activeMessageId: string
  onSelect: (messageId: string) => void
}) => {
  const t = activityInspectorMessages.useTranslate()
  if (turns.length < 2) {
    return null
  }
  const current = turns.find((item) => item.messageId === activeMessageId) ?? turns.at(-1)
  if (!current) {
    return null
  }

  const labelFor = (item: SessionTurnSummary) =>
    item.promptExcerpt
      ? t('turnOptionWithPrompt', { number: item.turnNumber, prompt: item.promptExcerpt })
      : t('turnShortLabel', { number: item.turnNumber })

  return (
    <Menu
      align="start"
      alignOffset={0}
      offset={6}
      maxHeight={320}
      ariaLabel={t('turnSelectorLabel')}
      className={styles.turnMenu}
      options={turns.map((item) => ({
        type: 'radio' as const,
        key: item.messageId,
        label: labelFor(item),
        checked: item.messageId === current.messageId,
        onSelect: () => onSelect(item.messageId),
      }))}
    >
      {({ open, triggerProps }) => (
        <button
          type="button"
          className={clsx(styles.turnMenuButton, open && styles.turnMenuButtonOpen)}
          title={labelFor(current)}
          aria-label={t('turnSelectorLabel')}
          {...triggerProps}
        >
          <span className={styles.turnMenuLabel}>
            {t('turnShortLabel', { number: current.turnNumber })}
          </span>
          <span className={styles.turnMenuChevron} aria-hidden="true">
            <IconChevronDownOutline14 />
          </span>
        </button>
      )}
    </Menu>
  )
}
