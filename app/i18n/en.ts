import type { zh } from './zh.js'

export const en = {
  settings: 'Settings',
  appName: 'DeepSeek',
  settingDialogAsideGeneralOptionLabel: 'General',
  settingDialogAsideDataOptionLabel: 'Data',
  settingDialogAsideApiKeyOptionLabel: 'API key',
  retry: 'Retry',
  errorBoundaryTitle: 'Something went wrong',
  errorBoundaryDescription: 'An unexpected error occurred. Try again or reload the app.',
  errorBoundaryReload: 'Reload',
  widenPanel: 'Widen panel',
  narrowPanel: 'Narrow panel',
  resizeSidePanel: 'Resize side panel',
} satisfies Record<keyof typeof zh, string>
