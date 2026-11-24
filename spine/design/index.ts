/**
 * Stateless, domain-blind UI primitives shared by every slice and the app shell.
 * Visual tokens live in app/theme.css (global CSS variables).
 */
export { Button } from './Button.js'
export { IconButton } from './IconButton.js'
export { Menu, type MenuOption } from './Menu.js'
export { Modal } from './Modal.js'
export { Select, type SelectOption } from './Select.js'
export { Toast } from './Toast.js'
export { copyText } from './clipboard.js'
export { FileIcon } from './FileIcon.js'
export { Tooltip, type TooltipPlacement } from './Tooltip.js'
export {
  HOVER_GLIDE_ITEM_ATTR,
  HoverGlideIndicator,
  hoverGlideItem,
  useHoverGlide,
  type HoverGlideOptions,
  type HoverGlideResult,
} from './HoverGlide.js'
export {
  INITIAL_HOVER_GLIDE_STATE,
  enterGlideTarget,
  expireGlideCooldown,
  glideRectsEqual,
  leaveGlideTarget,
  measureGlideRect,
  syncGlideRect,
  type BoxRect,
  type GlideRect,
  type HoverGlideEffect,
  type HoverGlideState,
  type HoverGlideTransition,
} from './hoverGlideState.js'
export { DeepSeekMark } from './logo.js'
export * from './icons.js'
export {
  VIEWPORT_PADDING,
  useAnchoredPosition,
  useDelayedOpen,
  useDismiss,
  type Align,
  type AnchoredOptions,
  type AnchoredPosition,
  type Side,
} from './anchored.js'
export {
  MOBILE_BREAKPOINT_PX,
  PANEL_DURATION_MS,
  THEME_ATTR,
  applyDocumentTheme,
  type ThemeMode,
  type ThemeRoot,
} from './theme.js'
export { usePresence } from './usePresence.js'
export { useIsMobile } from './viewport.js'
export { acquireOverlay, isOverlayOpen, onOverlayChange } from './overlay.js'
export {
  getToast,
  showToast,
  useToast,
  type ToastContent,
  type ToastSnapshot,
} from './toastStore.js'
export { SettingRow, settingStyles, type SettingStatus } from './SettingRow.js'
export {
  maskSecret,
  useSecretKeyForm,
  type KeyCheck,
  type SecretKeyForm,
  type SecretKeyFormOptions,
} from './secretKey.js'
export { StageFrame } from './stage/StageFrame.js'
export { ViewportMenu } from './stage/ViewportMenu.js'
export * from './stage/viewport.js'
export type { PanelLayout, PanelSlot, StageHost, StageSize } from './stage/host.js'
/** Shared side-panel chrome (empty states, error banner, top actions, mode chip) and stage styles. */
export { default as panelStyles } from './stage/stage.module.css'
