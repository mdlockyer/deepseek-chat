import { DEFAULT_LOCALE } from '@deepseek-chat/spine/i18n'
import { historyBackupMessages, type HistoryBackupMessageKey } from './messages.js'

/** 导入导出失败的原因，key 对应界面提示文案。 */
export class BackupError extends Error {
  readonly key: HistoryBackupMessageKey

  constructor(key: HistoryBackupMessageKey) {
    super(historyBackupMessages.translate(DEFAULT_LOCALE, key))
    this.name = 'BackupError'
    this.key = key
  }
}

export const fail = (key: HistoryBackupMessageKey): never => {
  throw new BackupError(key)
}
