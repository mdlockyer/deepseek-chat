import { IconButton, IconSettingsOutline16 } from '@deepseek-chat/lib-ui'
import { useConversations } from '../../context.js'
import { useTranslate } from '../../messages.js'

const isMacPlatform =
  typeof navigator !== 'undefined' &&
  /Mac|iPhone|iPad/i.test(navigator.platform || navigator.userAgent)

/** Permanent top-right Settings trigger shared across Welcome, SessionView, loading, and mobile headers. */
export const SettingsHeaderButton = ({ mobile = false }: { mobile?: boolean }) => {
  const t = useTranslate()
  const { deps } = useConversations()
  const label = t('settings')
  const tooltip = isMacPlatform ? `${label} (⌘,)` : label

  return (
    <IconButton
      size={mobile ? 'xl' : 'm'}
      tone={mobile ? 'primary' : 'tertiary'}
      icon={<IconSettingsOutline16 />}
      aria-label={label}
      tooltip={mobile ? undefined : tooltip}
      tooltipPlacement="bottom"
      onClick={() => deps.ui.openSettings('general')}
    />
  )
}
