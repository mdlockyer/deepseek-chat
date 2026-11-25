/**
 * Minimal domain-blind design contract shared across all tiers:
 * - Semantic CSS tokens live in `./tokens.css` (`@deepseek-chat/spine/tokens.css`)
 * - Root theme contract and cross-tier motion/breakpoint constants live in `./theme.ts`
 * - Translation mechanism and locale state live in `./i18n.ts` (`@deepseek-chat/spine/i18n`)
 *
 * Interactive UI primitives live in `@deepseek-chat/lib-ui`; viewport stage helpers live in
 * `@deepseek-chat/lib-stage`.
 */
export {
  MOBILE_BREAKPOINT_PX,
  PANEL_DURATION_MS,
  THEME_ATTR,
  applyDocumentTheme,
  type ThemeMode,
  type ThemeRoot,
} from './theme.js'
