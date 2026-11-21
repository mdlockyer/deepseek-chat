import { IconButton, IconPlayMediaOutline16, showToast } from '@deepseek-chat/spine/design'
import { useSyncExternalStore } from 'react'
import { voiceMessages } from './messages.js'
import { type ReadAloud } from './readAloud.js'
import { ReadingBars } from './ReadingBars.js'

/** 朗读按钮：未朗读时点击开始，加载中或朗读中点击停止；正文原样提交，由服务端过滤 markdown */
export const createReadAloudButton = (readAloud: ReadAloud) => {
  const ReadAloudButton = ({ messageId, text }: { messageId: string; text: string }) => {
    const t = voiceMessages.useTranslate()
    const status = useSyncExternalStore(
      readAloud.subscribe,
      () => {
        const state = readAloud.getState()
        return state.status !== 'idle' && state.messageId === messageId ? state.status : 'idle'
      },
      () => 'idle' as const
    )
    return (
      <IconButton
        icon={status === 'idle' ? <IconPlayMediaOutline16 /> : <ReadingBars mode={status} />}
        tooltip={status === 'idle' ? t('ttsPlay') : t('ttsStop')}
        tooltipPlacement="bottom"
        onClick={() => readAloud.toggle(messageId, text, (message) => showToast({ text: message }))}
      />
    )
  }
  return ReadAloudButton
}
