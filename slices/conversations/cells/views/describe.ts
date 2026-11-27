import { ApiError as LibApiError, classifyApiError } from '@deepseek-chat/lib-agent'
import type { ArchiveAssistantMessage } from '@deepseek-chat/lib-chat-archive-contract'
import type { Locale } from '@deepseek-chat/spine/i18n'
import { isTranslationKey, translate } from '../../kernel/index.js'

export type Notice = {
  text: string
  /** 模板答复使用正文样式；其余统一为红色错误提示。 */
  presentation?: 'response'
  /** 需要用户处理的问题附带的操作 */
  action?: 'apiKey' | 'topUp'
}

const getTemplateText = (reply: ArchiveAssistantMessage) =>
  reply.blocks
    .map((block) => (block.type === 'text' && block.isTemplate ? block.text : ''))
    .join('')

/** 回复出错或未正常结束时展示的提示 */
export const describeReply = (reply: ArchiveAssistantMessage, locale?: Locale): Notice | null => {
  if (reply.status === 'error' && reply.error) {
    const { kind, status, localMessage } = reply.error
    // 导入的历史可能来自不同版本；不识别的文案沿用保存时的原文。
    const message =
      localMessage && isTranslationKey(localMessage.key)
        ? translate(locale, localMessage.key, localMessage.params)
        : reply.error.message
    // 历史补传错误刷新后仍需说明原因，恢复沿用附件卡片或重新生成。
    if (kind === 'upload') {
      return { text: message || translate(locale, 'uploadFileStatusFailed') }
    }
    if (kind === 'network') {
      return { text: translate(locale, 'commonNetworkErrorToast') }
    }
    switch (classifyApiError(new LibApiError(kind, reply.error.message, status))) {
      case 'unauthorized':
        return { text: translate(locale, 'replyInvalidApiKey'), action: 'apiKey' }
      case 'insufficientBalance':
        return { text: translate(locale, 'replyInsufficientBalance'), action: 'topUp' }
      case 'contextOverflow':
        return { text: translate(locale, 'replyContextOverflow') }
      case 'payloadTooLarge':
        return { text: translate(locale, 'replyPayloadTooLarge') }
      case 'rateLimited':
        return { text: translate(locale, 'replyRateLimited') }
      case 'serverBusy':
        return { text: translate(locale, 'completionServerBusyToast') }
      default:
        return message ? { text: message } : null
    }
  }
  const template = getTemplateText(reply)
  // 归档不带结构化错误，错误文案保存在模板中，仍按错误提示展示。
  if (reply.status === 'error' && template) {
    return { text: template }
  }
  if (reply.stopReason === 'refusal') {
    // 导入的拒绝回复优先展示归档中的模板，普通正文仍不可展示。
    return { text: template || translate(locale, 'replyRefused'), presentation: 'response' }
  }
  if (template) {
    return { text: template, presentation: 'response' }
  }
  return null
}
