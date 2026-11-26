import { defineMessages } from '@deepseek-chat/spine/i18n'

export const historyBackupMessages = defineMessages({
  'zh-CN': {
    cancel: '取消',
    delete: '删除…',
    upload: '上传',
    backupIncomplete: '文件内容不完整，无法导入',
    backupInvalidJson: '文件不是有效的 JSON',
    backupUnrecognized: '无法识别该文件，请选择 DeepSeek 导出的历史对话 ZIP 文件',
    backupNewerVersion: '文件版本过新，请升级后再导入',
    backupInvalidVersion: '文件版本无效，无法导入',
    backupInvalidBranches: '文件中的消息分支已损坏，无法导入',
    backupInvalidFiles: '文件中的附件数据已损坏，无法导入',
    historyImport: '导入历史对话',
    historyImportConfirm: '确认导入',
    historyImportConfirmTitle: '确认导入历史对话？',
    historyImportConfirmDescription: '上传的历史对话会覆盖当前所有对话记录，是否确认导入？',
    historyImportDescription:
      '导入历史对话会覆盖全部本地对话和附件，支持 DeepSeek 导出的 ZIP 文件。',
    historyImportedOne: '已导入 1 个对话',
    historyImported: '已导入 {count} 个对话',
    historyImportFailed:
      '文件导入失败，可能是文件格式错误或使用了旧版的对话导出 ZIP 文件，请前往 DeepSeek 重新导出历史对话文件后再次导入。',
    historyExportFailed: '导出失败：{message}',
    exportAllLabel: '导出所有历史对话',
    historyExportDescription:
      '包含所有历史对话及本地图片原件；其他附件仅保留文件信息，不包含 API Key。',
    exportAllDownload: '下载',
    deleteAllSessions: '删除所有对话',
    deleteAllSessionsModalTitle: '删除后，所有对话都将被清空且无法找回',
    deleteAllSessionsModalDescription: '本地保存的附件及未发送的草稿也将被删除。',
    historyDeleting: '删除中...',
    historyDeleted: '删除成功',
    historyDeleteFailed: '删除失败，请重试',
  },
  'en-US': {
    cancel: 'Cancel',
    delete: 'Delete…',
    upload: 'Upload',
    backupIncomplete: 'The file is incomplete and cannot be imported.',
    backupInvalidJson: 'The file is not valid JSON.',
    backupUnrecognized: 'File not recognized. Please choose a DeepSeek chat history ZIP.',
    backupNewerVersion: 'This file uses a newer version. Please update the app before importing.',
    backupInvalidVersion: 'The file version is invalid and cannot be imported.',
    backupInvalidBranches:
      'The conversation branches in this file are corrupted and cannot be imported.',
    backupInvalidFiles: 'The attachment data in this file is corrupted and cannot be imported.',
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
  },
})

export type HistoryBackupMessageKey = Parameters<typeof historyBackupMessages.translate>[0]

export type HistoryBackupTranslationMessage = {
  readonly key: HistoryBackupMessageKey
  readonly params?: Record<string, string | number>
}
