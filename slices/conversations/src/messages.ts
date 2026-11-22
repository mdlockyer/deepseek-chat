import { defineMessages, type MessageParams } from '@deepseek-chat/spine/i18n'

export const conversationsMessages = defineMessages({
  'zh-CN': {
    requestTimedOut: '请求超时，请检查网络连接后重试',
    uploadUnsupportedFormat:
      '上传的文件包含暂未支持的文件格式，请转换文件格式后重试。支持 PDF、DOC、XLSX、PPT、图片、文本、代码等。',
    uploadMaxMBSize: '单个文件大小超过限制（{size}MB），请调整后重试',
    uploadMaxFiles: '上传文件最多支持 {count} 个',
    uploadServerBusy: '服务器繁忙',
    uploadParseFailed: '解析失败',
    uploadFileStatusFailed: '上传失败',
    uploadDeleteFiles: '删除文件',
    uploadFileCountLimit: '已上传文件数达到上限（{limit} 个），可 ',
    uploadStorageLimit: '已上传文件占用空间达到上限（{limit}GB），可 ',
    commonNetworkErrorToast: '网络异常，请检查你的网络状况',
    replyInvalidApiKey: 'API Key 无效或已被删除，请更换后重试',
    replyInsufficientBalance: '账户余额不足，请充值后重试',
    replyRateLimited: '请求过于频繁，请稍后再试',
    completionServerBusyToast: '服务器繁忙，请稍后再试',
    replyRefused: '你好，这个问题我暂时无法回答，让我们换个话题再聊聊吧。',
    backupIncomplete: '文件内容不完整，无法导入',
    backupInvalidJson: '文件不是有效的 JSON',
    backupUnrecognized: '无法识别该文件，请选择 DeepSeek 导出的历史对话 ZIP 文件',
    backupNewerVersion: '文件版本过新，请升级后再导入',
    backupInvalidVersion: '文件版本无效，无法导入',
    backupInvalidBranches: '文件中的消息分支已损坏，无法导入',
    backupInvalidFiles: '文件中的附件数据已损坏，无法导入',
    latestReminderLanguage: '中文',
    sessionHistoryTimelineLabelToday: '今天',
    sessionHistoryTimelineLabelYesterday: '昨天',
    sessionHistoryTimelineLabel7days: '7 天内',
    sessionHistoryTimelineLabel30days: '30 天内',
    thinkingSwitch: '深度思考',
    messageThinkDuration: '已思考（用时 {count} 秒）',
    messageThinkDurationPlural: '已思考（用时 {count} 秒）',
    messageThinkStopped: '已停止',
    imageSearching: '图像搜索中...',
    deepSearchSearching: '正在搜索',
    groupTitleToolOpen: '正在浏览网页',
    readingLink: '正在阅读',
    pythonRunning: '正在运行 Python',
    previewToolEditing: '正在更新 {name}',
    previewToolReading: '正在读取 {name}',
    previewToolPresenting: '正在创建 {name}',
    messageThinking: '正在思考',
  },
  'en-US': {
    requestTimedOut: 'Request timed out. Please check your network and try again.',
    uploadUnsupportedFormat:
      'The selected files include unsupported formats. Please convert them and try again. Supported: PDF, DOC, XLSX, PPT, images, text, code, and more.',
    uploadMaxMBSize: 'File exceeds the size limit ({size} MB). Please adjust and try again.',
    uploadMaxFiles: 'You can upload up to {count} files',
    uploadServerBusy: 'Server busy',
    uploadParseFailed: 'Parsing failed',
    uploadFileStatusFailed: 'Upload failed',
    uploadDeleteFiles: 'Delete files',
    uploadFileCountLimit: 'Uploaded file limit reached ({limit} files). ',
    uploadStorageLimit: 'Uploaded file storage limit reached ({limit} GB). ',
    commonNetworkErrorToast: 'Network Error. Please check your network status.',
    replyInvalidApiKey:
      'The API Key is invalid or has been deleted. Please replace it and try again.',
    replyInsufficientBalance: 'Insufficient account balance. Please top up and try again.',
    replyRateLimited: 'Too many requests. Please try again later.',
    completionServerBusyToast: 'Server busy, please try again later.',
    replyRefused: "Sorry, that's beyond my current scope. Let's talk about something else.",
    backupIncomplete: 'The file is incomplete and cannot be imported.',
    backupInvalidJson: 'The file is not valid JSON.',
    backupUnrecognized: 'File not recognized. Please choose a DeepSeek chat history ZIP.',
    backupNewerVersion: 'This file uses a newer version. Please update the app before importing.',
    backupInvalidVersion: 'The file version is invalid and cannot be imported.',
    backupInvalidBranches:
      'The message branches in this file are corrupted and cannot be imported.',
    backupInvalidFiles: 'The attachment data in this file is corrupted and cannot be imported.',
    latestReminderLanguage: 'English',
    sessionHistoryTimelineLabelToday: 'Today',
    sessionHistoryTimelineLabelYesterday: 'Yesterday',
    sessionHistoryTimelineLabel7days: '7 Days',
    sessionHistoryTimelineLabel30days: '30 Days',
    thinkingSwitch: 'DeepThink',
    messageThinkDuration: 'Thought for {count} second',
    messageThinkDurationPlural: 'Thought for {count} seconds',
    messageThinkStopped: 'Stopped',
    imageSearching: 'Searching by image...',
    deepSearchSearching: 'Searching the web',
    groupTitleToolOpen: 'Browsing the web',
    readingLink: 'Reading',
    pythonRunning: 'Running Python',
    previewToolEditing: 'Updating {name}',
    previewToolReading: 'Reading {name}',
    previewToolPresenting: 'Creating {name}',
    messageThinking: 'Thinking',
  },
})

export type TranslationKey = Parameters<typeof conversationsMessages.translate>[0]
export type TranslationParams = MessageParams
/** A string of this slice's catalogue with its parameters, translated when shown. */
export type TranslationMessage = { key: TranslationKey; params?: TranslationParams }
/** 带文字链接的提示：link 跟在正文后，在新窗口打开；type 为 error 时前面带错误图标 */
export type LinkedMessage = TranslationMessage & {
  type?: 'error'
  link?: { key: TranslationKey; href: string }
}

export const isTranslationKey = conversationsMessages.has
export const translate = conversationsMessages.translate
export const useTranslate = conversationsMessages.useTranslate
