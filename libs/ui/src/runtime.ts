import { MOBILE_BREAKPOINT_PX } from '@deepseek-chat/spine/design'
import type { NoticeContent, NoticePort, OverlayPort } from '@deepseek-chat/spine/ports'
import { useEffect, useState, useSyncExternalStore } from 'react'

export type OverlayCoordinator = OverlayPort & {
  isOpen(): boolean
  getCount(): number
  /** Fires `true` on 0->1 and `false` on 1->0. */
  subscribe(listener: (open: boolean) => void): () => void
  /** Fires on every acquire/release count change (useful for diagnostics/workbench). */
  subscribeCount(listener: () => void): () => void
}

/** Reference-counted overlay lock coordinator (zero module-level global state). */
export const createOverlayCoordinator = (): OverlayCoordinator => {
  let openCount = 0
  const edgeListeners = new Set<(open: boolean) => void>()
  const countListeners = new Set<() => void>()

  const notifyEdge = (open: boolean) => {
    for (const listener of [...edgeListeners]) {
      listener(open)
    }
  }

  const notifyCount = () => {
    for (const listener of [...countListeners]) {
      listener()
    }
  }

  return {
    acquire() {
      openCount += 1
      notifyCount()
      if (openCount === 1) {
        notifyEdge(true)
      }
      let released = false
      return () => {
        if (released) {
          return
        }
        released = true
        openCount -= 1
        notifyCount()
        if (openCount === 0) {
          notifyEdge(false)
        }
      }
    },
    isOpen: () => openCount > 0,
    getCount: () => openCount,
    subscribe(listener) {
      edgeListeners.add(listener)
      return () => {
        edgeListeners.delete(listener)
      }
    },
    subscribeCount(listener) {
      countListeners.add(listener)
      return () => {
        countListeners.delete(listener)
      }
    },
  }
}

export type NoticeSnapshot = {
  readonly id: number
  readonly content: NoticeContent | null
}

export type NoticeBusOptions = {
  readonly defaultDurationMs?: number
  readonly linkDurationMs?: number
}

export type NoticeBus = NoticePort & {
  getSnapshot(): NoticeSnapshot
  clear(): void
  subscribe(listener: () => void): () => void
}

const DEFAULT_NOTICE_DURATION_MS = 3000
const DEFAULT_LINK_NOTICE_DURATION_MS = 5000

/** Single-slot ephemeral notice bus (replaces global toastStore singleton). */
export const createNoticeBus = ({
  defaultDurationMs = DEFAULT_NOTICE_DURATION_MS,
  linkDurationMs = DEFAULT_LINK_NOTICE_DURATION_MS,
}: NoticeBusOptions = {}): NoticeBus => {
  let snapshot: NoticeSnapshot = { id: 0, content: null }
  let timer: ReturnType<typeof setTimeout> | undefined
  const listeners = new Set<() => void>()

  const emit = (next: NoticeSnapshot) => {
    snapshot = next
    for (const listener of [...listeners]) {
      listener()
    }
  }

  return {
    show(content) {
      clearTimeout(timer)
      const nextId = snapshot.id + 1
      emit({ id: nextId, content })
      timer = setTimeout(
        () => {
          if (snapshot.id === nextId) {
            emit({ id: nextId, content: null })
          }
        },
        content.link ? linkDurationMs : defaultDurationMs
      )
    },
    clear() {
      clearTimeout(timer)
      if (snapshot.content !== null) {
        emit({ id: snapshot.id, content: null })
      }
    },
    getSnapshot: () => snapshot,
    subscribe(listener) {
      listeners.add(listener)
      return () => {
        listeners.delete(listener)
      }
    },
  }
}

const MOBILE_QUERY = `not all and (min-width: ${MOBILE_BREAKPOINT_PX}px)`
const REDUCED_MOTION_QUERY = '(prefers-reduced-motion: reduce)'

let mobileQuery: MediaQueryList | null = null
const getMobileQuery = (): MediaQueryList | null => {
  if (typeof window === 'undefined' || typeof window.matchMedia !== 'function') {
    return null
  }
  mobileQuery ??= window.matchMedia(MOBILE_QUERY)
  return mobileQuery
}

const subscribeMobile = (onChange: () => void) => {
  const media = getMobileQuery()
  if (!media) {
    return () => undefined
  }
  media.addEventListener('change', onChange)
  return () => media.removeEventListener('change', onChange)
}

export const useIsMobile = (): boolean =>
  useSyncExternalStore(
    subscribeMobile,
    () => getMobileQuery()?.matches ?? false,
    () => false
  )

/** Keeps a closing overlay mounted for `durationMs` so its exit transition completes cleanly. */
export const usePresence = (open: boolean, durationMs: number) => {
  const [mounted, setMounted] = useState(open)
  if (open && !mounted) {
    setMounted(true)
  }

  useEffect(() => {
    if (open) {
      setMounted(true)
      return
    }
    const reduced =
      typeof window !== 'undefined' &&
      typeof window.matchMedia === 'function' &&
      window.matchMedia(REDUCED_MOTION_QUERY).matches
    if (durationMs <= 0 || reduced) {
      setMounted(false)
      return
    }
    const timer = window.setTimeout(() => setMounted(false), durationMs)
    return () => window.clearTimeout(timer)
  }, [open, durationMs])

  return { mounted, exiting: mounted && !open }
}

/** Copies plain text to the clipboard with an execCommand fallback for non-HTTPS contexts. */
export const copyText = async (text: string): Promise<boolean> => {
  try {
    if (navigator.clipboard?.writeText) {
      await navigator.clipboard.writeText(text)
      return true
    }
  } catch {
    // Fall back to a hidden textarea when clipboard permissions are restricted.
  }

  if (typeof document === 'undefined') {
    return false
  }
  const textarea = document.createElement('textarea')
  textarea.value = text
  textarea.readOnly = true
  textarea.style.cssText = 'position:fixed;top:0;left:0;opacity:0;font-size:16px'

  try {
    document.body.appendChild(textarea)
    textarea.focus({ preventScroll: true })
    textarea.select()
    textarea.setSelectionRange(0, textarea.value.length)
    return document.execCommand('copy')
  } catch {
    return false
  } finally {
    textarea.remove()
  }
}
