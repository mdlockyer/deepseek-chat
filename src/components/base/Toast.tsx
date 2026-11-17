import clsx from 'clsx'
import { useRef } from 'react'
import { useTranslate } from '../../i18n/index.js'
import { usePresence } from '../../utils/usePresence.js'
import { IconToastError16 } from './icons.js'
import { useToast } from './toastState.js'
import styles from './Toast.module.css'

export const Toast = () => {
  const t = useTranslate()
  const { id, message } = useToast()
  // 退场淡出期间消息已清空，保留最后一条用于播放退场
  const lastRef = useRef({ id, message })
  if (message) {
    lastRef.current = { id, message }
  }
  const { mounted, exiting } = usePresence(message !== null, 160)
  if (!mounted) {
    return null
  }
  const shown = message ? { id, message } : lastRef.current
  if (!shown.message) {
    return null
  }
  const shownMessage = shown.message
  if (typeof shownMessage === 'string') {
    return (
      <div key={shown.id} className={clsx(styles.toast, exiting && styles.exiting)} role="status">
        {shownMessage}
      </div>
    )
  }
  const error = shownMessage.type === 'error'
  return (
    <div
      key={shown.id}
      className={clsx(styles.toast, error && styles.error, exiting && styles.exiting)}
      role="status"
    >
      {error ? (
        <span className={styles.icon}>
          <IconToastError16 />
        </span>
      ) : null}
      <span className={styles.content}>
        {t(shownMessage.key, shownMessage.params)}
        {shownMessage.link ? (
          <a className={styles.link} href={shownMessage.link.href} target="_blank" rel="noreferrer">
            {t(shownMessage.link.key)}
          </a>
        ) : null}
      </span>
    </div>
  )
}
