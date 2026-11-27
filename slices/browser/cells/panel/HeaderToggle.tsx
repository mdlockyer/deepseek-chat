import { IconButton, IconGlobeLanguageOutline16 } from '@deepseek-chat/lib-ui'
import type { PanelSlot } from '@deepseek-chat/spine/ports'
import type { ComponentType } from 'react'
import {
  browserMessages,
  isControllingSession,
  type BrowserController,
} from '../../kernel/index.js'
import headerToggleStyles from './HeaderToggle.module.css'

export type BrowserHeaderToggleDeps = {
  readonly panel: PanelSlot
  readonly desktop: boolean
}

export const createBrowserHeaderToggle = (
  controller: BrowserController,
  deps: BrowserHeaderToggleDeps
): ComponentType<{ readonly sessionId: string }> => {
  const HeaderToggle: ComponentType<{ readonly sessionId: string }> = ({ sessionId }) => {
    const t = browserMessages.useTranslate()
    const open = deps.panel.useLayout(() => deps.panel.isOpen(sessionId))
    const controllingHere = controller.useState((s) => isControllingSession(s, sessionId))
    if (!deps.desktop) {
      return null
    }
    const backgroundActive = !open && controllingHere
    return (
      <IconButton
        size="m"
        tone="primary"
        className={
          open
            ? headerToggleStyles.active
            : backgroundActive
              ? headerToggleStyles.backgroundActive
              : undefined
        }
        icon={<IconGlobeLanguageOutline16 />}
        tooltip={t(
          open ? 'closeBrowser' : backgroundActive ? 'browserRunningBackground' : 'openBrowser'
        )}
        tooltipPlacement="bottom"
        aria-pressed={open}
        onClick={() => void controller.toggleBrowserPanel(sessionId)}
      />
    )
  }
  return HeaderToggle
}
