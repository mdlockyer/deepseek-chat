import { IconSlidersOutline14, MorphMenu, Switch } from '@deepseek-chat/lib-ui'
import clsx from 'clsx'
import { useEffect, useRef, useState } from 'react'
import { useTranslate } from '../../messages.js'
import { handleMenuRowKey, type ComposerToolSwitch } from './ComposerMenu.js'
import styles from './ToolsMenu.module.css'

/**
 * Pill under the composer's right edge: one icon per switch that is on (DeepThink and the
 * mounted tools), or a neutral sliders icon when all are off. It grows into a menu with every
 * switch, and the pill's icons fly to their rows as it opens and back as it closes, so a switch
 * turned on in the menu lands in the pill.
 */
export const ToolsMenu = ({
  tools,
  disabled = false,
}: {
  tools: ComposerToolSwitch[]
  disabled?: boolean
}) => {
  const t = useTranslate()
  const [open, setOpen] = useState(false)
  const anchorRef = useRef<HTMLButtonElement>(null)
  const listRef = useRef<HTMLDivElement>(null)
  const active = tools.filter((tool) => tool.checked)
  // Icons already shown (or present on first render) appear without the pop-in animation.
  const seenIconsRef = useRef<Set<string> | null>(null)
  if (seenIconsRef.current === null) {
    seenIconsRef.current = new Set(active.map((tool) => tool.key))
  }
  const seenIcons = seenIconsRef.current
  useEffect(() => {
    seenIcons.clear()
    for (const tool of active) {
      seenIcons.add(tool.key)
    }
  })
  const summary =
    active.length > 0
      ? t('toolsMenuSummary', { tools: active.map((tool) => tool.label).join(', ') })
      : t('toolsMenuLabel')

  return (
    <>
      <button
        ref={anchorRef}
        type="button"
        className={clsx(styles.pill, open && styles.pillOpen)}
        aria-label={summary}
        aria-haspopup="dialog"
        aria-expanded={open}
        disabled={disabled}
        onClick={() => setOpen((value) => !value)}
      >
        <span className={styles.icons} aria-hidden="true">
          {active.length > 0 ? (
            active.map((tool) => (
              <span
                key={tool.key}
                className={clsx(
                  styles.icon,
                  // A switch turned on in the menu arrives by flying in as the menu closes, so
                  // its chip does not also pop in (hidden under the menu, then mid-scale).
                  !open && !seenIcons.has(tool.key) && styles.iconEntering
                )}
                data-morph-from={tool.key}
              >
                {tool.icon}
              </span>
            ))
          ) : (
            <span key="none" className={clsx(styles.icon, styles.iconIdle)}>
              <IconSlidersOutline14 />
            </span>
          )}
        </span>
      </button>
      <MorphMenu
        open={open}
        onOpenChange={setOpen}
        anchorRef={anchorRef}
        side="top"
        align="end"
        measureKey={tools.length}
        autoFocusSurface
        role="dialog"
        ariaLabel={t('toolsMenuLabel')}
        className={styles.menu}
        contentRef={listRef}
        onKeyDown={(event) => {
          if (handleMenuRowKey(listRef.current, event.key)) {
            event.preventDefault()
          }
        }}
      >
        {tools.map((tool) => (
          <Switch
            key={tool.key}
            block
            data-composer-row=""
            icon={
              // Same key as the pill's chip: MorphMenu flies the icon between the two.
              <span className={styles.rowIcon} data-morph-to={tool.key}>
                {tool.icon}
              </span>
            }
            label={tool.label}
            checked={tool.checked}
            onChange={tool.onToggle}
          />
        ))}
      </MorphMenu>
    </>
  )
}
