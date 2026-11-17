import { translate, type TranslationKey } from '../../../i18n/index.js'

/** 导入导出失败的原因，key 对应界面提示文案。 */
export class BackupError extends Error {
  readonly key: TranslationKey

  constructor(key: TranslationKey) {
    super(translate(key))
    this.name = 'BackupError'
    this.key = key
  }
}

export const fail = (key: TranslationKey): never => {
  throw new BackupError(key)
}
