import {
  buildCursorHideScript,
  buildCursorMoveScript,
  buildCursorPressScript,
  buildCursorRestoreScript,
} from './driver.js'
import { createKiteCursor, type KiteCursor } from './kiteCursor.js'

/** The longest an action waits for the cursor to land in the page. */
const PAGE_GLIDE_MAX_MS = 700
/** The longest it waits for the cursor to leave the page or reach a toolbar control. */
const CHROME_GLIDE_MAX_MS = 600
/** The longest the cursor takes to type a URL into the address bar. */
const ADDRESS_TYPING_MAX_MS = 450

type PagePoint = { readonly x: number; readonly y: number; readonly vw: number }

type Crossing = {
  readonly ms: number
  readonly x: number
  readonly vx: number
  readonly vy: number
}

type MoveResult = {
  readonly ok: boolean
  readonly moved?: boolean
  readonly x?: number
  readonly y?: number
  readonly ms?: number
  readonly vw?: number
  readonly cross?: Crossing | null
}

/** A browser toolbar control the cursor can press, by its `data-agent-target` name. */
export type ChromeTarget =
  | 'address'
  | 'back'
  | 'forward'
  | 'reload'
  | 'new-tab'
  | `tab:${string}`
  | `close:${string}`

/** Marks a toolbar control as one the agent cursor can press (spread onto the element). */
export const agentTarget = (target: ChromeTarget) => ({ 'data-agent-target': target })

/** Marks the element the page's webview is drawn over, so the cursor can map page to window. */
export const BROWSER_VIEWPORT_MARK = { 'data-browser-viewport': '' } as const

export type AgentCursorDeps = {
  /** Runs a driver script in a tab and parses its JSON (throws when it reports a failure). */
  readonly evalJson: <T extends { ok: boolean }>(
    tabId: string,
    script: string,
    timeoutMs: number
  ) => Promise<T>
  /** Whether the tab is the page the reader can see right now. */
  readonly isTabOnScreen: (tabId: string) => boolean
  /** Shows `text` in the address bar of `tabId` while the cursor types it (`null` to stop). */
  readonly setAddressText: (tabId: string, text: string | null) => void
  readonly delay: (ms: number, signal: AbortSignal) => Promise<void>
}

/**
 * Moves one agent cursor between the browser's toolbar (drawn in the app's window) and the page
 * (drawn inside the webview), so the reader can follow what the model does from step to step. It
 * leaves the page through the top edge to reach the toolbar and comes back in the same way. The
 * model waits for it only while the page is on screen; nothing here ever stops an action.
 */
export const createAgentCursor = (deps: AgentCursorDeps) => {
  const pageAt = new Map<string, PagePoint>()
  let chrome: KiteCursor | null = null

  const hasWindow = () => typeof document !== 'undefined' && typeof window !== 'undefined'
  const chromeCursor = (): KiteCursor | null => {
    if (!hasWindow()) {
      return null
    }
    if (!chrome || !chrome.isConnected()) {
      chrome = createKiteCursor(document, window)
    }
    return chrome
  }

  const viewportRect = (): DOMRect | null =>
    hasWindow()
      ? (document.querySelector<HTMLElement>('[data-browser-viewport]')?.getBoundingClientRect() ??
        null)
      : null

  /** Page pixels to window pixels: the webview draws the page scaled to fit its box. */
  const toWindow = (point: PagePoint, rect: DOMRect) => {
    const zoom = point.vw > 0 ? rect.width / point.vw : 1
    return { x: rect.left + point.x * zoom, y: rect.top + point.y * zoom, zoom }
  }

  const wait = async (ms: number | undefined, cap: number, signal: AbortSignal) => {
    if (typeof ms === 'number' && ms > 0) {
      await deps.delay(Math.min(ms, cap), signal)
    }
  }

  const movePage = async (
    tabId: string,
    target: Parameters<typeof buildCursorMoveScript>[0]
  ): Promise<MoveResult | null> => {
    try {
      const result = await deps.evalJson<MoveResult>(
        tabId,
        buildCursorMoveScript({ ...target, screenWidth: viewportRect()?.width ?? null }),
        3_000
      )
      if (result.moved && typeof result.x === 'number' && typeof result.y === 'number') {
        pageAt.set(tabId, { x: result.x, y: result.y, vw: result.vw ?? 0 })
      }
      return result
    } catch {
      return null
    }
  }

  /**
   * Sends the toolbar cursor down towards the action's target in the page and, at the moment its
   * tip crosses the page's top edge, returns where and how fast its page counterpart takes over:
   * the same spot, the same speed and heading, so the two read as one kite passing through the
   * edge. `null` when the toolbar cursor is not showing.
   */
  const enterFromChrome = async (
    tabId: string,
    target: Parameters<typeof buildCursorMoveScript>[0],
    signal: AbortSignal
  ) => {
    const c = chrome
    const at = c && c.isShown() ? c.position() : null
    const rect = viewportRect()
    if (!at || !rect || !c) {
      return null
    }
    // Where the target is on screen, so the toolbar cursor heads straight for it.
    const peek = await movePage(tabId, { ...target, peek: true })
    const vw = peek?.vw ?? pageAt.get(tabId)?.vw ?? 0
    const zoom = vw > 0 ? rect.width / vw : 1
    const goal =
      peek && typeof peek.x === 'number' && typeof peek.y === 'number'
        ? toWindow({ x: peek.x, y: peek.y, vw }, rect)
        : { x: Math.min(rect.right - 4, Math.max(rect.left + 4, at.x)), y: rect.top + 60 }
    const ms = c.moveTo(goal.x, Math.max(goal.y, rect.top + 8))
    const cross = c.crossing(rect.top)
    await wait(cross?.ms ?? ms, CHROME_GLIDE_MAX_MS, signal)
    // Past the edge the toolbar cursor is behind the page; it stops being drawn shortly after.
    c.hide()
    return {
      from: { x: ((cross?.x ?? goal.x) - rect.left) / zoom, y: 0 },
      launch: cross ? { vx: cross.vx / zoom, vy: cross.vy / zoom } : null,
    }
  }

  /**
   * Glides the cursor in the page to what an action is about to target, and waits for it to land
   * while the reader can see the page. A target that cannot be resolved is left for the action
   * itself to report.
   */
  const toTarget = async (
    tabId: string,
    target: { ref?: string; x?: number; y?: number; stay?: boolean },
    signal: AbortSignal
  ) => {
    const onScreen = deps.isTabOnScreen(tabId)
    const entry = onScreen ? await enterFromChrome(tabId, target, signal) : null
    const from = entry?.from ?? pageAt.get(tabId) ?? null
    const landed = await movePage(tabId, {
      ...target,
      from,
      enter: entry !== null,
      launch: entry?.launch ?? null,
    })
    if (landed?.moved && onScreen) {
      await wait(landed.ms, PAGE_GLIDE_MAX_MS, signal)
    }
  }

  /** Presses the cursor where it is in the page (a key press). */
  const pressInPage = async (tabId: string) => {
    try {
      await deps.evalJson(tabId, buildCursorPressScript(), 2_000)
    } catch {
      // Best effort.
    }
  }

  /**
   * Takes the cursor out of the page through its top edge and presses a toolbar control. Only
   * while the page is on screen: otherwise there is no one to show it to.
   */
  const pressChrome = async (tabId: string, target: ChromeTarget, signal: AbortSignal) => {
    if (!hasWindow() || !deps.isTabOnScreen(tabId)) {
      return
    }
    const control = document.querySelector<HTMLElement>(
      `[data-agent-target="${CSS.escape(target)}"]`
    )
    const c = chromeCursor()
    const rect = viewportRect()
    if (!control || !c) {
      return
    }
    const box = control.getBoundingClientRect()
    const goal =
      target === 'address'
        ? { x: box.left + Math.min(56, box.width / 3), y: box.top + box.height / 2 }
        : { x: box.left + box.width / 2, y: box.top + box.height / 2 }
    if (!c.isShown()) {
      const inPage = pageAt.get(tabId)
      if (inPage && rect) {
        // Head up out of the page; the moment the tip crosses the top edge, the toolbar cursor
        // takes over at the same spot and speed, so it reads as one kite passing through the edge.
        // The page cursor heads for the control itself (above the page, so off its top edge).
        const zoom = inPage.vw > 0 ? rect.width / inPage.vw : 1
        const left = await movePage(tabId, {
          point: { x: (goal.x - rect.left) / zoom, y: (goal.y - rect.top) / zoom },
          crossY: 0,
        })
        await wait(left?.cross?.ms ?? left?.ms, CHROME_GLIDE_MAX_MS, signal)
        const edgeX = left?.cross ? rect.left + left.cross.x * zoom : toWindow(inPage, rect).x
        pageAt.set(tabId, { ...inPage, x: (edgeX - rect.left) / zoom, y: 0 })
        if (left?.cross) {
          c.launch(edgeX, rect.top, left.cross.vx * zoom, left.cross.vy * zoom)
        } else {
          c.place(edgeX, rect.top)
        }
      } else {
        c.place(goal.x + 24, goal.y + 30)
      }
    }
    await wait(c.moveTo(goal.x, goal.y), CHROME_GLIDE_MAX_MS, signal)
    c.press(goal.x, goal.y)
  }

  /** Types `url` into the address bar, a few characters at a time, before the page loads it. */
  const typeAddress = async (tabId: string, url: string, signal: AbortSignal) => {
    if (!hasWindow() || !deps.isTabOnScreen(tabId) || !chrome?.isShown()) {
      return
    }
    const reduce =
      typeof window.matchMedia === 'function' &&
      window.matchMedia('(prefers-reduced-motion: reduce)').matches
    if (reduce || url.length === 0) {
      deps.setAddressText(tabId, url)
      return
    }
    const steps = Math.min(url.length, 18)
    for (let step = 1; step <= steps; step += 1) {
      deps.setAddressText(tabId, url.slice(0, Math.ceil((url.length * step) / steps)))
      await deps.delay(ADDRESS_TYPING_MAX_MS / steps, signal)
    }
  }

  /** The reply that drove these tabs has finished, or the reader took over: put the cursor away. */
  const hide = (tabIds: readonly string[]) => {
    chrome?.hide()
    for (const tabId of tabIds) {
      deps.setAddressText(tabId, null)
      if (pageAt.has(tabId)) {
        void deps.evalJson(tabId, buildCursorHideScript(), 2_000).catch(() => undefined)
      }
    }
  }

  /** Shows the page cursor again after a screenshot hid it. */
  const restoreAfterCapture = (tabId: string) =>
    deps.evalJson(tabId, buildCursorRestoreScript(), 2_000).catch(() => undefined)

  return {
    toTarget,
    pressInPage,
    pressChrome,
    typeAddress,
    hide,
    restoreAfterCapture,
    forgetTab: (tabId: string) => {
      pageAt.delete(tabId)
    },
    dispose: () => {
      pageAt.clear()
      chrome?.destroy()
      chrome = null
    },
  }
}

export type AgentCursor = ReturnType<typeof createAgentCursor>
