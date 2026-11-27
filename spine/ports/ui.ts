import type { Locale } from '../design/i18n.js'

/**
 * Domain-blind UI host ports owned by Tier 1 (The Spine).
 * Replaces global mutable UI singletons so slices and tests stay hermetic and isolated.
 */

export type NoticeTone = 'info' | 'error'

export type NoticeContent = {
  /** Resolved at render time in the active locale so notices follow live locale changes. */
  readonly text: (locale?: Locale) => string
  readonly tone?: NoticeTone
  readonly link?: { readonly text: (locale?: Locale) => string; readonly href: string }
}

/** Ephemeral user-facing status notification sink (implemented by the App Shell's toast bus). */
export type NoticePort = {
  show(content: NoticeContent): void
}

/**
 * Coordinates HTML overlays (dialogs, menus, popovers, drawers) with native OS surfaces
 * (such as embedded child webviews) that paint above the DOM.
 */
export type OverlayPort = {
  /** Marks an overlay as open; returns an idempotent release function. */
  acquire(): () => void
}

export const noopNoticePort: NoticePort = {
  show: () => undefined,
}

export const noopOverlayPort: OverlayPort = {
  acquire: () => () => undefined,
}
