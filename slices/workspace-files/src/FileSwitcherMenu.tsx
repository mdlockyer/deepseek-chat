import { PanelTitleMenu } from '@deepseek-chat/lib-ui'
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

/** The preview header's title: the file on show, and a switcher when the chat has several files. */
export const FileSwitcherMenu = ({
  items,
  current,
  onSelect,
}: {
  items: PreviewFileItem[]
  current: PreviewFileItem
  onSelect: (key: string) => void
}) => {
  return (
    <PanelTitleMenu
      label={current.title}
      title={current.name}
      icon={<FileIcon ext={getExtension(current.name)} />}
      menuClassName={styles.fileMenu}
      options={items.map((item) => ({
        type: 'radio' as const,
        key: item.key,
        label: item.title,
        detail: formatSize(item.active.size),
        icon: <FileIcon ext={getExtension(item.name)} />,
        checked: item.key === current.key,
        onSelect: () => onSelect(item.key),
      }))}
    />
  )
}
