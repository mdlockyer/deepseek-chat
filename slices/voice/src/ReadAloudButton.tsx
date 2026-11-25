import { IconButton, IconPlayMediaOutline16 } from '@deepseek-chat/lib-ui'
import type { NoticePort } from '@deepseek-chat/spine/ports'
import { useSyncExternalStore } from 'react'
import { voiceMessages } from './messages.js'
import { type ReadAloud } from './readAloud.js'
import { ReadingBars } from './ReadingBars.js'

export const createReadAloudButton = (readAloud: ReadAloud, notify: NoticePort) => {
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
        onClick={() =>
          readAloud.toggle(messageId, text, (message) => notify.show({ text: message }))
        }
      />
    )
  }
  return ReadAloudButton
}
