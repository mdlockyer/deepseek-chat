import clsx from 'clsx'
import { useRef } from 'react'
import { IconToastError16 } from './icons.js'
import { useLocale } from './i18n.js'
import { useToast, type ToastSnapshot } from './toastStore.js'
import { usePresence } from './usePresence.js'
import styles from './Toast.module.css'

export const Toast = () => {
  // 文案在渲染时按当前语言取值，切换语言时重新渲染
  useLocale()
  const current = useToast()
  // 退场淡出期间内容已清空，保留最后一条用于播放退场
  const lastRef = useRef<ToastSnapshot>(current)
  if (current.content) {
    lastRef.current = current
  }
  const { mounted, exiting } = usePresence(current.content !== null, 160)
  if (!mounted) {
    return null
  }
  const shown = current.content ? current : lastRef.current
  const content = shown.content
  if (!content) {
    return null
  }
  const error = content.tone === 'error'
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
        {content.text()}
        {content.link ? (
          <a className={styles.link} href={content.link.href} target="_blank" rel="noreferrer">
            {content.link.text()}
          </a>
        ) : null}
      </span>
    </div>
  )
}
