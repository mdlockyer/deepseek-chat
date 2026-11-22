import type { zh } from './zh.js'

export const en = {
  settings: 'Settings',
  appName: 'DeepSeek',
  cancel: 'Cancel',
  delete: 'Delete',
  settingDialogAsideGeneralOptionLabel: 'General',
  settingDialogAsideDataOptionLabel: 'Data',
  settingDialogAsideApiKeyOptionLabel: 'API key',
  historyImport: 'Import chat history',
  historyImportConfirm: 'Import',
  historyImportConfirmTitle: 'Import chat history?',
  historyImportConfirmDescription:
    'The uploaded chat history will replace all your current chats. Import anyway?',
  historyImportDescription:
    'Importing chat history replaces all local chats and attachments. Supports ZIP files exported from DeepSeek.',
  historyImportedOne: 'Imported 1 chat',
  historyImported: 'Imported {count} chats',
  historyImportFailed:
    'File import failed. The file format may be invalid, or the ZIP file may use an older chat export format. Please export your chat history from DeepSeek again and retry the import.',
  historyExportFailed: 'Export failed: {message}',
  exportAllLabel: 'Export all chats',
  historyExportDescription:
    'Includes all chat history and locally stored images. Other attachments retain file details only. Your API Key is not included.',
  exportAllDownload: 'Download',
  deleteAllSessions: 'Delete all chats',
  deleteAllSessionsModalTitle: 'Once deleted, all chats will be cleared and cannot be recovered.',
  deleteAllSessionsModalDescription:
    'Locally saved attachments and unsent drafts will also be deleted.',
  historyDeleting: 'Deleting...',
  historyDeleted: 'Successfully deleted.',
  historyDeleteFailed: 'Failed to delete chats. Please try again.',
  upload: 'Upload',
  browserBackToResults: 'Results',
  retry: 'Retry',
  errorBoundaryTitle: 'Something went wrong',
  errorBoundaryDescription: 'An unexpected error occurred. Try again or reload the app.',
  errorBoundaryReload: 'Reload',
} satisfies Record<keyof typeof zh, string>
