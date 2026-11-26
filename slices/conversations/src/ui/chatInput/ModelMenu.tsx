import {
  IconCheckOutline16,
  IconChevronDownOutline14,
  Popover,
  Switch,
} from '@deepseek-chat/lib-ui'
import clsx from 'clsx'
import { useEffect, useRef, useState, type RefObject } from 'react'
import { useTranslate } from '../../messages.js'
import { handleMenuRowKey, type ComposerToolSwitch } from './ComposerMenu.js'
import styles from './ModelMenu.module.css'

/**
 * Pill under the composer's right edge: the model name plus one icon per switch that is on
 * (DeepThink and the mounted tools). It opens a menu with the model and every switch.
 */
export const ModelMenu = ({
  modelLabel,
  tools,
  disabled = false,
  positionRef,
}: {
  modelLabel: string
  tools: ComposerToolSwitch[]
  disabled?: boolean
  /** Element the menu opens above (the composer box), so it never covers the draft. */
  positionRef?: RefObject<HTMLElement | null>
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
      ? t('modelMenuSummary', {
          model: modelLabel,
          tools: active.map((tool) => tool.label).join(', '),
        })
      : modelLabel

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
        <span className={styles.model}>{modelLabel}</span>
        {active.length > 0 ? (
          <span className={styles.icons} aria-hidden="true">
            {active.map((tool) => (
              <span
                key={tool.key}
                className={clsx(styles.icon, !seenIcons.has(tool.key) && styles.iconEntering)}
              >
                {tool.icon}
              </span>
            ))}
          </span>
        ) : null}
        <span className={styles.chevron} aria-hidden="true">
          <IconChevronDownOutline14 />
        </span>
      </button>
      <Popover
        open={open}
        onOpenChange={setOpen}
        anchorRef={anchorRef}
        positionRef={positionRef}
        side="top"
        align="end"
        offset={8}
        measureKey={tools.length}
        exitDurationMs={160}
        autoFocusSurface
        role="dialog"
        ariaLabel={t('modelMenuLabel')}
        className={styles.menu}
        onKeyDown={(event) => {
          if (handleMenuRowKey(listRef.current, event.key)) {
            event.preventDefault()
          }
        }}
      >
        <div ref={listRef} className={styles.list}>
          <p className={styles.section}>{t('modelMenuModel')}</p>
          <div className={styles.modelRow}>
            <span className={styles.modelRowLabel}>{modelLabel}</span>
            <span className={styles.check} aria-hidden="true">
              <IconCheckOutline16 />
            </span>
          </div>
          <div className={styles.divider} role="separator" />
          <p className={styles.section}>{t('modelMenuTools')}</p>
          {tools.map((tool) => (
            <Switch
              key={tool.key}
              block
              data-composer-row=""
              icon={tool.icon}
              label={tool.label}
              checked={tool.checked}
              onChange={tool.onToggle}
            />
          ))}
        </div>
      </Popover>
    </>
  )
}
