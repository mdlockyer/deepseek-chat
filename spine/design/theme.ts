/**
 * Domain-blind theme and layout constants owned by Tier 1 (The Spine).
 * Visual values live in `./tokens.css`; the App Shell calls `applyDocumentTheme`
 * on the root `<html>` element so `:root[data-theme]` and `color-scheme` stay in sync.
 */

export type ThemeMode = 'light' | 'dark'

export const THEME_ATTR = 'data-theme'
export const MOBILE_BREAKPOINT_PX = 768
export const PANEL_DURATION_MS = 280

export type ThemeRoot = {
  setAttribute(name: string, value: string): void
  style: { colorScheme: string }
}

/** Applies the resolved theme to the document root (`<html>`). */
export const applyDocumentTheme = (root: ThemeRoot, theme: ThemeMode): void => {
  root.setAttribute(THEME_ATTR, theme)
  root.style.colorScheme = theme
}
