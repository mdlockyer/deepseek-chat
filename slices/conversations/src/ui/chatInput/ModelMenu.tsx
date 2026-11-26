import {
  IconCheckOutline16,
  IconChevronDownOutline14,
  Popover,
  Switch,
} from '@deepseek-chat/lib-ui'
import clsx from 'clsx'
import { useRef, useState } from 'react'
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
}: {
  modelLabel: string
  tools: ComposerToolSwitch[]
  disabled?: boolean
}) => {
  const t = useTranslate()
  const [open, setOpen] = useState(false)
  const anchorRef = useRef<HTMLButtonElement>(null)
  const listRef = useRef<HTMLDivElement>(null)
  const active = tools.filter((tool) => tool.checked)
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
              <span key={tool.key} className={styles.icon}>
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
        side="top"
        align="end"
        offset={8}
        measureKey={tools.length}
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
        <div ref={listRef}>
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
