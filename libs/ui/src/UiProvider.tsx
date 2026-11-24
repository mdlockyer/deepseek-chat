import {
  noopNoticePort,
  noopOverlayPort,
  type NoticePort,
  type OverlayPort,
} from '@deepseek-chat/spine/ports'
import { createContext, useContext, useEffect, useMemo, type ReactNode } from 'react'
import type { NoticeBus } from './runtime.js'

type UiContextValue = {
  readonly overlay: OverlayPort
  readonly noticePort: NoticePort
  readonly noticeBus: NoticeBus | null
}

const DEFAULT_CONTEXT: UiContextValue = {
  overlay: noopOverlayPort,
  noticePort: noopNoticePort,
  noticeBus: null,
}

const UiContext = createContext<UiContextValue>(DEFAULT_CONTEXT)

const isNoticeBus = (value: NoticePort | NoticeBus): value is NoticeBus =>
  'getSnapshot' in value && 'subscribe' in value

/**
 * Provides domain-blind UI runtime capabilities (`OverlayPort`, `NoticePort`/`NoticeBus`)
 * to all component kit primitives inside the subtree.
 */
export const UiProvider = ({
  overlay = noopOverlayPort,
  notices = noopNoticePort,
  children,
}: {
  overlay?: OverlayPort
  notices?: NoticePort | NoticeBus
  children?: ReactNode
}) => {
  const value = useMemo<UiContextValue>(
    () => ({
      overlay,
      noticePort: notices,
      noticeBus: isNoticeBus(notices) ? notices : null,
    }),
    [overlay, notices]
  )
  return <UiContext.Provider value={value}>{children}</UiContext.Provider>
}

export const useOverlayPort = (): OverlayPort => useContext(UiContext).overlay

export const useUiNotice = (): NoticePort => useContext(UiContext).noticePort

export const useNoticeBus = (): NoticeBus | null => useContext(UiContext).noticeBus

/** Acquires an OverlayPort lock while `active` is true and releases it on unmount or close. */
export const useOverlayLock = (active: boolean) => {
  const overlay = useOverlayPort()
  useEffect(() => (active ? overlay.acquire() : undefined), [active, overlay])
}
