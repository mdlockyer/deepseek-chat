import { IconChevronDownOutline14, Menu } from '@deepseek-chat/lib-ui'
import clsx from 'clsx'
import { useWorkspace } from './context.js'
import { formatSize, getExtension } from './format.js'
import styles from './PreviewPanel.module.css'
import type { FileVersionEntry } from './workspace.js'

const FileIcon = ({ ext }: { ext: string }) => {
  const { FileIcon: Icon } = useWorkspace().views
  return <Icon ext={ext} />
}

export type PreviewFileItem = {
  key: string
  title: string
  name: string
  versions: FileVersionEntry[]
  active: FileVersionEntry
}

/** Preview header file badge with a dropdown switcher when the conversation has multiple files. */
export const FileSwitcherMenu = ({
  items,
  current,
  onSelect,
}: {
  items: PreviewFileItem[]
  current: PreviewFileItem
  onSelect: (key: string) => void
}) => {
  const ext = getExtension(current.name)
  if (items.length <= 1) {
    return (
      <div className={styles.headerTitleStatic} title={current.name}>
        <span className={styles.headerFileIcon}>
          <FileIcon ext={ext} />
        </span>
        <span className={styles.headerTitleText}>{current.title}</span>
      </div>
    )
  }

  return (
    <Menu
      align="start"
      alignOffset={0}
      offset={6}
      maxHeight={320}
      className={styles.fileMenu}
      options={items.map((item) => ({
        type: 'radio' as const,
        key: item.key,
        label: `${item.title} (${formatSize(item.active.size)})`,
        icon: (
          <span className={styles.headerFileIcon}>
            <FileIcon ext={getExtension(item.name)} />
          </span>
        ),
        checked: item.key === current.key,
        onSelect: () => onSelect(item.key),
      }))}
    >
      {({ open, triggerProps }) => (
        <button
          type="button"
          className={clsx(styles.headerTitleBtn, open && styles.headerTitleBtnOpen)}
          title={current.name}
          {...triggerProps}
        >
          <span className={styles.headerFileIcon}>
            <FileIcon ext={ext} />
          </span>
          <span className={styles.headerTitleText}>{current.title}</span>
          <span className={styles.headerTitleChevron}>
            <IconChevronDownOutline14 />
          </span>
        </button>
      )}
    </Menu>
  )
}
