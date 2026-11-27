import type { PanelLayout } from '@deepseek-chat/spine/ports'
import type { BrowserBounds } from './host.js'
import { getActiveSessionTabs, isBrowserWebviewVisible } from './machine.js'
import { DEFAULT_BROWSER_BOUNDS, type BrowserKernelState } from './types.js'
import { boundsEqual } from './urls.js'

export type NativeSyncCache = {
  readonly tabId: string | null
  readonly visible: boolean | null
  readonly bounds: BrowserBounds | null
  readonly zoom: number | null
}

export const EMPTY_NATIVE_SYNC_CACHE: NativeSyncCache = {
  tabId: null,
  visible: null,
  bounds: null,
  zoom: null,
}

export type NativeSyncCommand =
  | { readonly kind: 'noop' }
  | { readonly kind: 'hide' }
  | {
      readonly kind: 'setActiveTab'
      readonly tabId: string
      readonly bounds: BrowserBounds
      readonly visible: boolean
      readonly zoom: number
    }
  | {
      readonly kind: 'setBounds'
      readonly bounds: BrowserBounds
      readonly zoom: number
    }

export type PlanNativeSyncInput = {
  readonly state: BrowserKernelState
  readonly layout: Pick<PanelLayout, 'animating' | 'resizing' | 'overlayLocked'>
  readonly desktop: boolean
  readonly isActiveRightPanel: boolean
  readonly isNativeCreated: (tabId: string) => boolean
  readonly cache: NativeSyncCache
  readonly forceBounds: boolean
}

export const planNativeSync = (input: PlanNativeSyncInput): NativeSyncCommand => {
  const { state, layout, desktop, isActiveRightPanel, isNativeCreated, cache, forceBounds } = input
  if (!desktop) {
    return { kind: 'noop' }
  }
  const session = getActiveSessionTabs(state)
  const active = session.tabs.find((t) => t.id === session.activeTabId)
  const visible = isBrowserWebviewVisible(
    state,
    layout,
    desktop,
    isNativeCreated,
    isActiveRightPanel
  )
  if (!active || !isNativeCreated(active.id)) {
    if (cache.visible !== false || cache.tabId !== null) {
      return { kind: 'hide' }
    }
    return { kind: 'noop' }
  }
  const bounds = state.bounds ?? DEFAULT_BROWSER_BOUNDS
  const zoom = active.zoom
  const tabOrVisChanged = cache.tabId !== active.id || cache.visible !== visible
  const layoutStable = !layout.animating && !layout.resizing
  const geomChanged =
    forceBounds ||
    !boundsEqual(cache.bounds, bounds) ||
    cache.zoom === null ||
    Math.abs(cache.zoom - zoom) >= 0.001
  if (tabOrVisChanged) {
    return { kind: 'setActiveTab', tabId: active.id, bounds, visible, zoom }
  }
  if (layoutStable && geomChanged) {
    return { kind: 'setBounds', bounds, zoom }
  }
  return { kind: 'noop' }
}

/**
 * Advances the native sync cache only after the host IPC succeeds. If the IPC fails, the cache is
 * invalidated so the next sync retries instead of assuming the host matches local state.
 */
export const commitNativeSync = (
  cache: NativeSyncCache,
  command: NativeSyncCommand,
  succeeded: boolean
): NativeSyncCache => {
  if (command.kind === 'noop') {
    return cache
  }
  if (!succeeded) {
    return EMPTY_NATIVE_SYNC_CACHE
  }
  switch (command.kind) {
    case 'hide':
      return { ...cache, tabId: null, visible: false }
    case 'setActiveTab':
      return {
        tabId: command.tabId,
        visible: command.visible,
        bounds: command.bounds,
        zoom: command.zoom,
      }
    case 'setBounds':
      return {
        ...cache,
        bounds: command.bounds,
        zoom: command.zoom,
      }
  }
}

export const invalidateNativeSyncCache = (
  cache: NativeSyncCache,
  tabId?: string
): NativeSyncCache => {
  if (tabId !== undefined && cache.tabId !== tabId) {
    return cache
  }
  return EMPTY_NATIVE_SYNC_CACHE
}

export const isNativeGeometryStale = (
  cache: NativeSyncCache,
  bounds: BrowserBounds,
  zoom: number | undefined,
  force: boolean
): boolean =>
  force ||
  !boundsEqual(cache.bounds, bounds) ||
  (zoom !== undefined && (cache.zoom === null || Math.abs(cache.zoom - zoom) >= 0.001))
