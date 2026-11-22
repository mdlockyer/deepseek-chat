import { useEffect, useRef, useState } from 'react'
import { useTranslate } from '../../messages.js'
import {
  IconButton,
  IconCheckOutline16,
  IconCopyOutline16,
  copyText,
} from '@deepseek-chat/spine/design'
import { showNotice } from '../../notice.js'

/** 复制成功后图标换成对勾 1 秒，期间再次点击不重复复制 */
export const CopyButton = ({ text }: { text: string }) => {
  const t = useTranslate()
  const [copied, setCopied] = useState(false)
  const timerRef = useRef<ReturnType<typeof setTimeout>>(undefined)
  useEffect(() => () => clearTimeout(timerRef.current), [])

  return (
    <IconButton
      icon={copied ? <IconCheckOutline16 /> : <IconCopyOutline16 />}
      tooltip={t('copy')}
      tooltipPlacement="bottom"
      onClick={async () => {
        if (copied) {
          return
        }
        if (!(await copyText(text))) {
          showNotice({ key: 'copyFailed' })
          return
        }
        setCopied(true)
        timerRef.current = setTimeout(() => setCopied(false), 1000)
      }}
    />
  )
}
