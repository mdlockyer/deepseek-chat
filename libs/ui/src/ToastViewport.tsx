import { useLocale } from '@deepseek-chat/spine/i18n'
import clsx from 'clsx'
import { useEffect, useRef, useSyncExternalStore } from 'react'
import { usePresence, type NoticeBus, type NoticeSnapshot } from './runtime.js'
import { useNoticeBus } from './UiProvider.js'
import styles from './ToastViewport.module.css'

const EMPTY_SNAPSHOT: NoticeSnapshot = { id: 0, content: null }
const noopSubscribe = () => () => undefined
const getEmptySnapshot = () => EMPTY_SNAPSHOT

const EXIT_DURATION_MS = 160

/**
 * Ephemeral toast presenter subscribing to the `NoticeBus` provided by `UiProvider`.
 * Re-evaluates `content.text()` on locale changes and uses native `popover="manual"`
 * when supported so notices stay visible above open `<dialog>` top-layer modals.
 */
export const ToastViewport = ({ bus: explicitBus }: { bus?: NoticeBus } = {}) => {
  useLocale()
  const contextBus = useNoticeBus()
  const bus = explicitBus ?? contextBus

  const current = useSyncExternalStore(
    bus ? bus.subscribe : noopSubscribe,
    bus ? bus.getSnapshot : getEmptySnapshot,
    bus ? bus.getSnapshot : getEmptySnapshot
  )

  const lastRef = useRef<NoticeSnapshot>(current)
  if (current.content) {
    lastRef.current = current
  }

  const { mounted, exiting } = usePresence(current.content !== null, EXIT_DURATION_MS)
  const toastRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    const el = toastRef.current as
      | (HTMLDivElement & { showPopover?: () => void; hidePopover?: () => void })
      | null
    if (!mounted || !el || typeof el.showPopover !== 'function') {
      return
    }
    try {
      el.setAttribute('popover', 'manual')
      el.showPopover()
    } catch {
      // Ignore if already open or detached during rapid transitions.
    }
    return () => {
      try {
        el.hidePopover?.()
      } catch {
        // Ignore if already closed.
      }
    }
  }, [mounted, current.id])

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
      ref={toastRef}
      key={shown.id}
      className={clsx(styles.toast, error && styles.error, exiting && styles.exiting)}
      role="status"
      aria-live={error ? 'assertive' : 'polite'}
    >
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
