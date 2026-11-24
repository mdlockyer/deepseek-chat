import { useLocale } from '@deepseek-chat/spine/i18n'
import clsx from 'clsx'
import { memo, useState } from 'react'
import { useTranslate } from '../../messages.js'
import {
  IconButton,
  IconEditOutline16,
  IconEllipsisOutline16,
  IconTrashOutline16,
  Menu,
  hoverGlideItem,
} from '@deepseek-chat/spine/design'
import { renameSession, selectSession } from '../../store.js'
import { type SessionSummary } from '../../types.js'
import { formatClock, sessionTitle } from '../../format.js'
import { closeMobileSider } from './mobileSiderState.js'
import styles from './SessionItem.module.css'

export const SessionItem = memo(function SessionItem({
  session,
  active,
  enterDelay = 0,
  onDelete,
}: {
  session: SessionSummary
  active: boolean
  enterDelay?: number
  onDelete: () => void
}) {
  const t = useTranslate()
  const locale = useLocale()
  const [editing, setEditing] = useState(false)
  const untitled = !session.title
  const displayTitle = sessionTitle(session, t('untitledChat'))
  const clock = untitled ? formatClock(session.updatedAt, locale) : null

  if (editing) {
    const finish = (title: string) => {
      setEditing(false)
      if (title.trim() && title.trim() !== displayTitle) {
        renameSession(session.id, title.trim())
      }
    }
    return (
      <li className={styles.item}>
        <input
          className={styles.renameInput}
          aria-label={t('sessionItemMenuRenameOption')}
          defaultValue={session.title || displayTitle}
          autoFocus
          onFocus={(event) => event.target.select()}
          onBlur={(event) => finish(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === 'Enter' && !event.nativeEvent.isComposing) {
              finish(event.currentTarget.value)
            } else if (event.key === 'Escape') {
              setEditing(false)
            }
          }}
        />
      </li>
    )
  }

  return (
    <li
      className={clsx(styles.item, active && styles.active)}
      style={enterDelay ? { animationDelay: `${enterDelay}ms` } : undefined}
      {...hoverGlideItem(active)}
    >
      <button
        type="button"
        className={styles.row}
        aria-current={active ? 'true' : undefined}
        onClick={() => {
          selectSession(session.id)
          closeMobileSider()
        }}
      >
        <span className={clsx(styles.title, untitled && styles.untitled)}>{displayTitle}</span>
      </button>
      {clock ? (
        <span className={styles.time} aria-hidden="true">
          {clock}
        </span>
      ) : null}
      <div className={styles.action} onClick={(event) => event.stopPropagation()}>
        <Menu
          options={[
            {
              key: 'rename',
              label: t('sessionItemMenuRenameOption'),
              icon: <IconEditOutline16 />,
              onSelect: () => setEditing(true),
            },
            {
              key: 'delete',
              label: t('delete'),
              icon: <IconTrashOutline16 />,
              danger: true,
              onSelect: onDelete,
            },
          ]}
        >
          {({ toggle }) => (
            <IconButton icon={<IconEllipsisOutline16 />} aria-label={t('more')} onClick={toggle} />
          )}
        </Menu>
      </div>
    </li>
  )
})
