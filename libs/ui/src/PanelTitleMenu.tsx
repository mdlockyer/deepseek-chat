import clsx from 'clsx'
import type { ReactNode } from 'react'
import type { Align } from './anchored.js'
import { IconChevronDownOutline14 } from './icons.js'
import { Menu, type MenuOption } from './Menu.js'
import styles from './PanelTitleMenu.module.css'

export type PanelTitleMenuProps = {
  /** What the header shows: the current view or item. */
  label: string
  icon?: ReactNode
  /** The views or items to switch between; with fewer than two, the label shows as plain text. */
  options: MenuOption[]
  /** Names the menu for screen readers. */
  ariaLabel?: string
  /** Full text on hover, for a label that may truncate. */
  title?: string
  align?: Align
  className?: string
  menuClassName?: string
}

/**
 * A panel header's title that switches what the panel shows: the label with a chevron, opening a
 * menu of the alternatives. With only one option it is plain text in the same place and type, so
 * the header does not shift when a second option appears.
 */
export const PanelTitleMenu = ({
  label,
  icon,
  options,
  ariaLabel,
  title,
  align = 'start',
  className,
  menuClassName,
}: PanelTitleMenuProps) => {
  const content = (
    <>
      {icon ? <span className={styles.icon}>{icon}</span> : null}
      <span className={styles.label}>{label}</span>
    </>
  )
  if (options.filter((option) => option.type !== 'separator').length < 2) {
    return (
      <div className={clsx(styles.title, className)} title={title} data-tauri-drag-region="">
        {content}
      </div>
    )
  }
  return (
    <Menu
      align={align}
      alignOffset={0}
      offset={6}
      maxHeight={320}
      ariaLabel={ariaLabel}
      className={clsx(styles.menu, menuClassName)}
      options={options}
    >
      {({ open, triggerProps }) => (
        <button
          type="button"
          className={clsx(styles.title, styles.trigger, open && styles.open, className)}
          title={title}
          {...triggerProps}
        >
          {content}
          <span className={styles.chevron}>
            <IconChevronDownOutline14 />
          </span>
        </button>
      )}
    </Menu>
  )
}
