import clsx from 'clsx'
import { useEffect, useId, useRef, type ReactNode } from 'react'
import { IconButton } from './IconButton.js'
import { IconCloseOutline16 } from './icons.js'
import { uiMessages } from './messages.js'
import { useOverlayLock } from './UiProvider.js'
import styles from './Dialog.module.css'

export type DialogSize = 'sm' | 'md' | 'lg'

export type DialogProps = {
  open: boolean
  title: ReactNode
  children?: ReactNode
  footer?: ReactNode
  size?: DialogSize
  closable?: boolean
  /** When false, Escape and outside clicks are ignored (e.g., while a destructive op is busy). */
  dismissible?: boolean
  /** Renders as a bottom sheet on narrow mobile viewports. */
  sheetOnMobile?: boolean
  className?: string
  mainClassName?: string
  onClose: () => void
}

const isPointerOutside = (event: PointerEvent, dialog: HTMLElement): boolean => {
  const rect = dialog.getBoundingClientRect()
  return (
    event.clientX < rect.left ||
    event.clientX > rect.right ||
    event.clientY < rect.top ||
    event.clientY > rect.bottom
  )
}

let cachedSupportsDisplayTransition: boolean | null = null
const canTransitionDisplay = (): boolean => {
  if (cachedSupportsDisplayTransition !== null) {
    return cachedSupportsDisplayTransition
  }
  if (
    typeof window === 'undefined' ||
    !window.CSS?.supports?.('transition-behavior', 'allow-discrete') ||
    !document.body
  ) {
    return false
  }
  const probe = document.createElement('div')
  probe.style.cssText = 'transition: display 1s allow-discrete !important; display: block;'
  document.body.appendChild(probe)
  void getComputedStyle(probe).display
  probe.style.display = 'none'
  cachedSupportsDisplayTransition = getComputedStyle(probe).display === 'block'
  probe.remove()
  return cachedSupportsDisplayTransition
}

const supportsNativeTopLayerExit = (): boolean =>
  typeof window !== 'undefined' &&
  Boolean(window.CSS?.supports?.('overlay', 'auto')) &&
  canTransitionDisplay()

/**
 * Native modal `<dialog>` using `.showModal()`, `::backdrop`, top-layer promotion,
 * Safari click-outside fallback (pointerdown + pointerup outside bounding box),
 * and top-layer exit animation fallback via `[data-closing]`.
 */
export const Dialog = ({
  open,
  title,
  children,
  footer,
  size = 'sm',
  closable = false,
  dismissible = true,
  sheetOnMobile = false,
  className,
  mainClassName,
  onClose,
}: DialogProps) => {
  const t = uiMessages.useTranslate()
  const titleId = useId()
  const dialogRef = useRef<HTMLDialogElement>(null)
  const panelRef = useRef<HTMLDivElement>(null)
  const onCloseRef = useRef(onClose)
  onCloseRef.current = onClose
  const dismissibleRef = useRef(dismissible)
  dismissibleRef.current = dismissible

  useOverlayLock(open)

  useEffect(() => {
    const dialog = dialogRef.current
    if (!dialog) {
      return
    }
    let cancelled = false

    const closeDialog = async () => {
      if (!dialog.open) {
        return
      }
      if (!supportsNativeTopLayerExit()) {
        dialog.setAttribute('data-closing', '')
        const animations =
          typeof dialog.getAnimations === 'function' ? dialog.getAnimations({ subtree: true }) : []
        if (animations.length > 0) {
          await Promise.race([
            Promise.allSettled(animations.map((a) => a.finished)),
            new Promise((resolve) => window.setTimeout(resolve, 250)),
          ])
        }
        if (cancelled || !dialog.hasAttribute('data-closing')) {
          return
        }
        dialog.removeAttribute('data-closing')
      }
      if (dialog.open) {
        dialog.close()
      }
    }

    if (open) {
      dialog.removeAttribute('data-closing')
      if (!dialog.open && typeof dialog.showModal === 'function') {
        dialog.showModal()
      }
    } else {
      void closeDialog()
    }

    return () => {
      cancelled = true
    }
  }, [open])

  useEffect(() => {
    const dialog = dialogRef.current
    if (!dialog) {
      return
    }

    const onCancel = (event: Event) => {
      event.preventDefault()
      if (dismissibleRef.current) {
        onCloseRef.current()
      }
    }

    let pressedOutside = false
    const onPointerDown = (event: PointerEvent) => {
      if (!dialog.open || !dismissibleRef.current) {
        pressedOutside = false
        return
      }
      if (event.target instanceof Element && event.target.closest('[data-ui-floating]')) {
        pressedOutside = false
        return
      }
      const targetBox = panelRef.current ?? dialog
      pressedOutside = isPointerOutside(event, targetBox)
    }

    const onPointerUp = (event: PointerEvent) => {
      if (!pressedOutside || !dialog.open || !dismissibleRef.current) {
        pressedOutside = false
        return
      }
      pressedOutside = false
      if (event.target instanceof Element && event.target.closest('[data-ui-floating]')) {
        return
      }
      const targetBox = panelRef.current ?? dialog
      if (isPointerOutside(event, targetBox)) {
        onCloseRef.current()
      }
    }

    dialog.addEventListener('cancel', onCancel)
    dialog.addEventListener('pointerdown', onPointerDown)
    dialog.addEventListener('pointerup', onPointerUp)
    return () => {
      dialog.removeEventListener('cancel', onCancel)
      dialog.removeEventListener('pointerdown', onPointerDown)
      dialog.removeEventListener('pointerup', onPointerUp)
    }
  }, [])

  if (!open && typeof window === 'undefined') {
    return null
  }

  return (
    <dialog
      ref={dialogRef}
      aria-labelledby={titleId}
      className={clsx(styles.dialog, sheetOnMobile && styles.sheetOnMobile)}
    >
      {open ? (
        <div ref={panelRef} className={clsx(styles.panel, styles[size], className)}>
          <div className={styles.header}>
            <h1 id={titleId} className={styles.title}>
              {title}
            </h1>
            {closable ? (
              <IconButton
                className={styles.close}
                tone="primary"
                icon={<IconCloseOutline16 />}
                aria-label={t('close')}
                disabled={!dismissible}
                onClick={() => {
                  if (dismissible) {
                    onClose()
                  }
                }}
              />
            ) : null}
          </div>
          {children ? <div className={clsx(styles.main, mainClassName)}>{children}</div> : null}
          {footer ? <div className={styles.footer}>{footer}</div> : null}
        </div>
      ) : null}
    </dialog>
  )
}
