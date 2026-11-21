import { useSyncExternalStore } from 'react'

/**
 * Toast store: one toast at a time, a new one replaces the old, each disappears on its own.
 * Text is a function so it is rendered in the locale current at render time.
 */
export type ToastContent = {
  readonly text: () => string
  readonly tone?: 'error'
  readonly link?: { readonly text: () => string; readonly href: string }
}

export type ToastSnapshot = { readonly id: number; readonly content: ToastContent | null }

const DURATION_MS = 3000
/** Toasts with a link stay longer so the link can be clicked. */
const LINK_DURATION_MS = 5000

let snapshot: ToastSnapshot = { id: 0, content: null }
let timer: ReturnType<typeof setTimeout> | undefined
const listeners = new Set<() => void>()

const update = (next: ToastSnapshot) => {
  snapshot = next
  for (const listener of [...listeners]) {
    listener()
  }
}

export const showToast = (content: ToastContent) => {
  clearTimeout(timer)
  update({ id: snapshot.id + 1, content })
  timer = setTimeout(
    () => update({ id: snapshot.id, content: null }),
    content.link ? LINK_DURATION_MS : DURATION_MS
  )
}

const subscribe = (listener: () => void) => {
  listeners.add(listener)
  return () => {
    listeners.delete(listener)
  }
}

export const getToast = () => snapshot

export const useToast = (): ToastSnapshot => useSyncExternalStore(subscribe, getToast, getToast)
