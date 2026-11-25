import { Chip, IconChevronDownOutline14, Menu } from '@deepseek-chat/lib-ui'
import { formatSize } from './format.js'
import { workspaceMessages } from './messages.js'
import styles from './PreviewPanel.module.css'
import type { FileVersionEntry } from './workspace.js'

/** File revision selector built on `@deepseek-chat/lib-ui` `Menu` + `Chip`. */
export const VersionMenu = ({
  versions,
  selectedFileId,
  onSelect,
}: {
  versions: FileVersionEntry[]
  selectedFileId: string
  onSelect: (fileId: string | null) => void
}) => {
  const t = workspaceMessages.useTranslate()
  const latest = versions.at(-1)
  const current = versions.find((v) => v.fileId === selectedFileId) ?? latest

  if (!current || versions.length <= 1) {
    return null
  }

  return (
    <Menu
      align="start"
      alignOffset={0}
      offset={6}
      maxHeight={280}
      className={styles.versionMenu}
      options={[...versions].reverse().map((item) => {
        const isLatest = item.fileId === latest?.fileId
        const versionText = t('previewVersionLabel', { version: item.version })
        const suffix = isLatest ? ` · ${t('previewVersionLatest')}` : ''
        return {
          type: 'radio' as const,
          key: item.fileId,
          label: `${versionText}${suffix} · ${formatSize(item.size)}`,
          checked: item.fileId === current.fileId,
          onSelect: () => onSelect(isLatest ? null : item.fileId),
        }
      })}
    >
      {({ open, triggerProps }) => (
        <Chip active={open} {...triggerProps}>
          <span>{t('previewVersionLabel', { version: current.version })}</span>
          <IconChevronDownOutline14 />
        </Chip>
      )}
    </Menu>
  )
}
