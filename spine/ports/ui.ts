/**
 * Domain-blind UI host ports owned by Tier 1 (The Spine).
 * Replaces global mutable UI singletons so slices and tests stay hermetic and isolated.
 */

export type NoticeTone = 'info' | 'error'

export type NoticeContent = {
  /** Resolved at render time so active notices follow live locale changes. */
  readonly text: () => string
  readonly tone?: NoticeTone
  readonly link?: { readonly text: () => string; readonly href: string }
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

export type MemoryNoticePort = NoticePort & {
  readonly history: readonly NoticeContent[]
  latest(): NoticeContent | null
  clear(): void
}

/** In-memory NoticePort for hermetic slice tests (analogous to `memoryStore`). */
export const memoryNoticePort = (): MemoryNoticePort => {
  const entries: NoticeContent[] = []
  return {
    get history() {
      return [...entries]
    },
    show(content) {
      entries.push(content)
    },
    latest() {
      return entries.at(-1) ?? null
    },
    clear() {
      entries.length = 0
    },
  }
}

export const noopNoticePort: NoticePort = {
  show: () => undefined,
}

export const noopOverlayPort: OverlayPort = {
  acquire: () => () => undefined,
}
