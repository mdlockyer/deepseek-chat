import { defineMessages, type MessageParams } from '@deepseek-chat/spine/i18n'
import { en } from './en.js'
import { zh } from './zh.js'

/**
 * The legacy app catalogue, built on the spine's translation mechanism. Strings move out of here
 * into each slice's own catalogue as that slice is extracted.
 */

export type TranslationKey = keyof typeof zh
export type TranslationParams = MessageParams
export type TranslationMessage = { key: TranslationKey; params?: TranslationParams }
/** 带文字链接的提示：link 跟在正文后，在新窗口打开；type 为 error 时前面带错误图标 */
export type LinkedMessage = TranslationMessage & {
  type?: 'error'
  link?: { key: TranslationKey; href: string }
}

const messages = defineMessages<TranslationKey>({ 'zh-CN': zh, 'en-US': en })

export const isTranslationKey = messages.has

/** 组件订阅语言变化；普通函数在调用时读取当前语言。 */
export const useTranslate = messages.useTranslate

export const translate = messages.translate
