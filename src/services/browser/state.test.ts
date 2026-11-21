import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import {
  computeDraggedViewportSize,
  findMatchingViewportPreset,
  getDefaultCustomViewportSize,
  isCustomViewport,
  parseCustomViewportInput,
} from '@deepseek-chat/spine/design'
import {
  clampBrowserResizeWidth,
  clearAllSessionBrowsers,
  closeBrowserTab,
  createBrowserTab,
  disposeSessionBrowser,
  fitViewportToStage,
  getSessionBrowser,
  isBrowserWebviewVisibleState,
  isHttpUrl,
  normalizeOmniboxInput,
  openBrowserPanel,
  resolveViewportRequest,
  setActiveBrowserSession,
  setBrowserPanelResizing,
  setBrowserStageSize,
  setBrowserTabViewport,
  useBrowserStore,
  type BrowserTab,
} from './state.js'

const makeTab = (overrides: Partial<BrowserTab> = {}): BrowserTab => ({
  id: 'tab-1',
  url: 'https://www.google.com/',
  title: 'Google',
  isLoading: false,
  canGoBack: false,
  canGoForward: false,
  viewport: null,
  zoom: 1,
  snapshotUrl: null,
  snapshotWidth: null,
  snapshotHeight: null,
  error: null,
  ...overrides,
})

const resetStore = (activeSessionId: string | null = null) => {
  useBrowserStore.setState({
    activeSessionId,
    sessions: {},
    panelAnimating: false,
    panelResizing: false,
    overlayLocks: 0,
    controlling: false,
    controllingAction: null,
    controllingSessionId: null,
    bounds: null,
    stageSize: null,
  })
}

describe('browser omnibox & URL normalization', () => {
  it('recognizes http/https URLs and rejects other schemes', () => {
    assert.equal(isHttpUrl('https://example.com'), true)
    assert.equal(isHttpUrl('http://localhost:3000/path'), true)
    assert.equal(isHttpUrl('about:blank'), false)
    assert.equal(isHttpUrl('javascript:alert(1)'), false)
    assert.equal(isHttpUrl('file:///etc/passwd'), false)
  })

  it('normalizes domains, localhost, explicit schemes, and search queries', () => {
    assert.equal(normalizeOmniboxInput(''), 'about:blank')
    assert.equal(normalizeOmniboxInput('   '), 'about:blank')
    assert.equal(normalizeOmniboxInput('https://deepseek.com/docs'), 'https://deepseek.com/docs')
    assert.equal(normalizeOmniboxInput('deepseek.com'), 'https://deepseek.com')
    assert.equal(normalizeOmniboxInput('localhost:5173/app'), 'http://localhost:5173/app')
    assert.equal(normalizeOmniboxInput('127.0.0.1:8080'), 'http://127.0.0.1:8080')
    assert.equal(
      normalizeOmniboxInput('how to use tauri webviews'),
      'https://www.google.com/search?q=how%20to%20use%20tauri%20webviews'
    )
  })
})

describe('browser resize clamping & native webview visibility', () => {
  it('clamps resize width between 360px and min(window - 360, 72vw)', () => {
    assert.equal(clampBrowserResizeWidth(240, 1200), 360)
    assert.equal(clampBrowserResizeWidth(600.4, 1200), 600)
    // 1200 - 360 = 840 < 1200 * 0.72 = 864
    assert.equal(clampBrowserResizeWidth(950, 1200), 840)
    // 1800 * 0.72 = 1296 < 1800 - 360 = 1440
    assert.equal(clampBrowserResizeWidth(1400, 1800), 1296)
    // Narrow window still floors at 360px
    assert.equal(clampBrowserResizeWidth(500, 600), 360)
  })

  it('hides native webview while panelResizing, panelAnimating, overlayLocks, or no active session', () => {
    const tab = makeTab()
    const base = {
      activeSessionId: 's1',
      sessions: {
        s1: {
          panelOpen: true,
          tabs: [tab],
          activeTabId: tab.id,
        },
      },
      panelAnimating: false,
      panelResizing: false,
      overlayLocks: 0,
    }
    const created = (id: string) => id === tab.id

    assert.equal(isBrowserWebviewVisibleState(base, true, created), true)
    assert.equal(
      isBrowserWebviewVisibleState({ ...base, activeSessionId: null }, true, created),
      false
    )
    assert.equal(
      isBrowserWebviewVisibleState({ ...base, panelResizing: true }, true, created),
      false
    )
    assert.equal(
      isBrowserWebviewVisibleState({ ...base, panelAnimating: true }, true, created),
      false
    )
    assert.equal(isBrowserWebviewVisibleState({ ...base, overlayLocks: 1 }, true, created), false)
    assert.equal(
      isBrowserWebviewVisibleState(
        {
          ...base,
          sessions: { s1: { panelOpen: false, tabs: [tab], activeTabId: tab.id } },
        },
        true,
        created
      ),
      false
    )
    assert.equal(isBrowserWebviewVisibleState(base, false, created), false)
    assert.equal(
      isBrowserWebviewVisibleState(
        {
          ...base,
          sessions: {
            s1: {
              panelOpen: true,
              tabs: [makeTab({ url: 'about:blank' })],
              activeTabId: tab.id,
            },
          },
        },
        true,
        created
      ),
      false
    )
  })

  it('updates panelResizing state immediately through setBrowserPanelResizing', () => {
    setBrowserPanelResizing(false)
    assert.equal(useBrowserStore.getState().panelResizing, false)
    setBrowserPanelResizing(true)
    assert.equal(useBrowserStore.getState().panelResizing, true)
    setBrowserPanelResizing(false)
    assert.equal(useBrowserStore.getState().panelResizing, false)
  })
})

describe('per-session browser ownership and tab lifecycle', () => {
  it('blocks opening or creating tabs on the new chat screen (activeSessionId === null)', async () => {
    resetStore(null)

    const opened = await openBrowserPanel()
    assert.equal(opened, false)
    assert.deepEqual(useBrowserStore.getState().sessions, {})
    await assert.rejects(() => createBrowserTab('about:blank'))
  })

  it('keeps tabs, panelOpen, and activeTabId isolated per session and disposes cleanly', async () => {
    resetStore('session-a')

    assert.equal(await openBrowserPanel('session-a'), true)
    const tabA1 = getSessionBrowser(useBrowserStore.getState(), 'session-a').tabs[0]
    assert.ok(tabA1)
    const tabA2 = await createBrowserTab('about:blank', { sessionId: 'session-a', activate: true })

    setActiveBrowserSession('session-b')
    assert.equal(getSessionBrowser(useBrowserStore.getState(), 'session-b').panelOpen, false)
    assert.equal(getSessionBrowser(useBrowserStore.getState(), 'session-b').tabs.length, 0)
    // Session A still retains its panel state and both tabs
    assert.equal(getSessionBrowser(useBrowserStore.getState(), 'session-a').panelOpen, true)
    assert.equal(getSessionBrowser(useBrowserStore.getState(), 'session-a').tabs.length, 2)
    assert.equal(getSessionBrowser(useBrowserStore.getState(), 'session-a').activeTabId, tabA2.id)

    await openBrowserPanel('session-b')
    const tabB1 = getSessionBrowser(useBrowserStore.getState(), 'session-b').tabs[0]
    assert.ok(tabB1)
    assert.notEqual(tabB1.id, tabA1.id)

    // Switch back to New Chat
    setActiveBrowserSession(null)
    assert.equal(useBrowserStore.getState().activeSessionId, null)
    assert.equal(getSessionBrowser(useBrowserStore.getState(), 'session-a').tabs.length, 2)

    // Deleting session-a removes only session-a's browser state
    await disposeSessionBrowser('session-a')
    assert.equal(getSessionBrowser(useBrowserStore.getState(), 'session-a').tabs.length, 0)
    assert.equal(getSessionBrowser(useBrowserStore.getState(), 'session-b').tabs.length, 1)

    await clearAllSessionBrowsers()
    assert.deepEqual(useBrowserStore.getState().sessions, {})
  })
})

describe('closeBrowserTab', () => {
  it('switches to sibling tab while tabs remain and closes the panel when closing the last tab', async () => {
    resetStore('session-1')

    await openBrowserPanel('session-1')
    assert.equal(getSessionBrowser(useBrowserStore.getState(), 'session-1').panelOpen, true)
    assert.equal(getSessionBrowser(useBrowserStore.getState(), 'session-1').tabs.length, 1)
    const first = getSessionBrowser(useBrowserStore.getState(), 'session-1').tabs[0]
    assert.ok(first)

    const second = await createBrowserTab('about:blank', {
      sessionId: 'session-1',
      activate: true,
    })
    assert.equal(getSessionBrowser(useBrowserStore.getState(), 'session-1').tabs.length, 2)
    assert.equal(getSessionBrowser(useBrowserStore.getState(), 'session-1').activeTabId, second.id)

    await closeBrowserTab(second.id)
    assert.equal(getSessionBrowser(useBrowserStore.getState(), 'session-1').panelOpen, true)
    assert.equal(getSessionBrowser(useBrowserStore.getState(), 'session-1').tabs.length, 1)
    assert.equal(getSessionBrowser(useBrowserStore.getState(), 'session-1').activeTabId, first.id)

    await closeBrowserTab(first.id)
    assert.equal(getSessionBrowser(useBrowserStore.getState(), 'session-1').tabs.length, 0)
    assert.equal(getSessionBrowser(useBrowserStore.getState(), 'session-1').activeTabId, null)
    assert.equal(getSessionBrowser(useBrowserStore.getState(), 'session-1').panelOpen, false)

    await openBrowserPanel('session-1')
    assert.equal(getSessionBrowser(useBrowserStore.getState(), 'session-1').panelOpen, true)
    assert.equal(getSessionBrowser(useBrowserStore.getState(), 'session-1').tabs.length, 1)
  })
})

describe('browser viewport presets, aspect ratios, and stage fitting', () => {
  it('resolves presets, aspect ratios, explicit bounds, and auto reset', () => {
    assert.equal(resolveViewportRequest({ preset: 'auto' }), null)
    assert.deepEqual(resolveViewportRequest({ preset: 'mobile' }), {
      width: 390,
      height: 844,
      preset: 'mobile',
      aspectRatio: null,
    })
    assert.deepEqual(resolveViewportRequest({ preset: 'desktop' }), {
      width: 1280,
      height: 720,
      preset: 'desktop',
      aspectRatio: null,
    })
    assert.deepEqual(resolveViewportRequest({ aspect_ratio: '16:9' }), {
      width: 1280,
      height: 720,
      preset: null,
      aspectRatio: '16:9',
    })
    assert.deepEqual(resolveViewportRequest({ aspect_ratio: '9:16' }), {
      width: 390,
      height: 693,
      preset: null,
      aspectRatio: '9:16',
    })
    assert.deepEqual(resolveViewportRequest({ aspect_ratio: '4:3', width: 800 }), {
      width: 800,
      height: 600,
      preset: null,
      aspectRatio: '4:3',
    })
    assert.deepEqual(resolveViewportRequest({ width: 100, height: 4000 }), {
      width: 320,
      height: 2560,
      preset: null,
      aspectRatio: null,
    })
    assert.throws(() => resolveViewportRequest({ aspect_ratio: 'wide' }))
    assert.throws(() => resolveViewportRequest({}))
  })

  it('fits any requested viewport inside the panel stage without overflowing', () => {
    // Auto fills stage at 1:1
    assert.deepEqual(fitViewportToStage(null, 520, 660), {
      boxWidth: 520,
      boxHeight: 660,
      zoom: 1,
      scale: 1,
      letterboxed: false,
      clipped: false,
    })

    // 1280x720 scales down inside 520x660
    const desktopFit = fitViewportToStage({ width: 1280, height: 720 }, 520, 660)
    assert.equal(desktopFit.boxWidth, 520)
    assert.equal(desktopFit.boxHeight, 293)
    assert.equal(desktopFit.letterboxed, true)
    assert.equal(desktopFit.clipped, false)
    assert.ok(Math.abs(desktopFit.zoom - 520 / 1280) < 0.001)

    // Small viewport renders 1:1 centered
    const smallFit = fitViewportToStage({ width: 390, height: 640 }, 520, 660)
    assert.equal(smallFit.boxWidth, 390)
    assert.equal(smallFit.boxHeight, 640)
    assert.equal(smallFit.zoom, 1)
    assert.equal(smallFit.letterboxed, true)

    // Tall mobile viewport scales by height
    const mobileFit = fitViewportToStage({ width: 390, height: 844 }, 520, 660)
    assert.equal(mobileFit.boxHeight, 660)
    assert.equal(mobileFit.boxWidth, 305)
    assert.ok(Math.abs(mobileFit.zoom - 660 / 844) < 0.001)

    // Ultra-wide request clamps zoom to 0.25 floor while still fitting inside stage
    const clippedFit = fitViewportToStage({ width: 2560, height: 1440 }, 340, 660)
    assert.equal(clippedFit.clipped, true)
    assert.equal(clippedFit.zoom, 0.25)
    assert.equal(clippedFit.boxWidth, 340)
    assert.equal(clippedFit.boxHeight, 191)
  })

  it('stores viewport overrides per tab independently', async () => {
    resetStore('session-v')
    setBrowserStageSize({ width: 520, height: 660 })

    const tabA = await createBrowserTab('about:blank', { sessionId: 'session-v', activate: true })
    const tabB = await createBrowserTab('about:blank', { sessionId: 'session-v', activate: false })

    await setBrowserTabViewport(tabA.id, { width: 1280, height: 720, preset: 'desktop' })

    const tabs = getSessionBrowser(useBrowserStore.getState(), 'session-v').tabs
    const updatedA = tabs.find((t) => t.id === tabA.id)
    const updatedB = tabs.find((t) => t.id === tabB.id)
    assert.equal(updatedA?.viewport?.width, 1280)
    assert.ok(updatedA && updatedA.zoom < 0.5)
    assert.equal(updatedB?.viewport, null)
    assert.equal(updatedB?.zoom, 1)
  })

  it('parses and validates custom viewport inputs at exact boundaries and rejects invalid formats', () => {
    // Valid custom dimensions (preset: null)
    assert.deepEqual(parseCustomViewportInput('1024', '768'), {
      ok: true,
      spec: { width: 1024, height: 768, preset: null, aspectRatio: null },
    })
    assert.deepEqual(parseCustomViewportInput(' 800px ', ' 600 PX '), {
      ok: true,
      spec: { width: 800, height: 600, preset: null, aspectRatio: null },
    })

    // Exact inclusive bounds: width 320..2560, height 240..2560
    assert.equal(parseCustomViewportInput('320', '240').ok, true)
    assert.equal(parseCustomViewportInput('2560', '2560').ok, true)

    // Explicit custom apply preserves preset: null so Custom mode and handles stay active
    assert.equal(findMatchingViewportPreset(1280, 720), 'desktop')
    assert.equal(findMatchingViewportPreset(1024, 768), null)
    assert.deepEqual(parseCustomViewportInput('1280', '720'), {
      ok: true,
      spec: { width: 1280, height: 720, preset: null, aspectRatio: null },
    })

    // Out-of-bounds identify the exact invalid field(s)
    assert.deepEqual(parseCustomViewportInput('319', '240'), {
      ok: false,
      widthInvalid: true,
      heightInvalid: false,
    })
    assert.deepEqual(parseCustomViewportInput('320', '239'), {
      ok: false,
      widthInvalid: false,
      heightInvalid: true,
    })
    assert.deepEqual(parseCustomViewportInput('2561', '2561'), {
      ok: false,
      widthInvalid: true,
      heightInvalid: true,
    })

    // Malformed strings are rejected rather than coerced
    assert.deepEqual(parseCustomViewportInput('', '  '), {
      ok: false,
      widthInvalid: true,
      heightInvalid: true,
    })
    assert.deepEqual(parseCustomViewportInput('-400', '1e3'), {
      ok: false,
      widthInvalid: true,
      heightInvalid: true,
    })
    assert.deepEqual(parseCustomViewportInput('800x', '600'), {
      ok: false,
      widthInvalid: true,
      heightInvalid: false,
    })
  })

  it('seeds default custom dimensions from active viewport, clamped stage size, or fallback', () => {
    assert.deepEqual(
      getDefaultCustomViewportSize({ width: 1000, height: 650 }, { width: 520, height: 660 }),
      { width: 1000, height: 650 }
    )
    assert.deepEqual(getDefaultCustomViewportSize(null, { width: 280.4, height: 660.6 }), {
      width: 320,
      height: 661,
    })
    assert.deepEqual(getDefaultCustomViewportSize(null, null), { width: 1024, height: 768 })
  })

  it('distinguishes custom viewports from presets and computes centered stage drag deltas', () => {
    assert.equal(isCustomViewport(null), false)
    assert.equal(isCustomViewport({ width: 1280, height: 720, preset: 'desktop' }), false)
    assert.equal(isCustomViewport({ width: 1280, height: 720, preset: null }), true)
    assert.equal(isCustomViewport({ width: 1024, height: 768 }), true)
    assert.equal(isCustomViewport({ width: 1280, height: 720 }), false)

    // Unscaled centered stage: dragging right +40px adds 2 * 40 = +80px width without changing height
    assert.deepEqual(
      computeDraggedViewportSize({
        startViewport: { width: 400, height: 500 },
        startZoom: 1,
        dx: 40,
        dy: 25,
        edge: 'right',
      }),
      { width: 480, height: 500 }
    )

    // Bottom edge changes height only
    assert.deepEqual(
      computeDraggedViewportSize({
        startViewport: { width: 400, height: 500 },
        startZoom: 1,
        dx: 40,
        dy: -30,
        edge: 'bottom',
      }),
      { width: 400, height: 440 }
    )

    // Scaled stage (zoom = 0.5) amplifies drag delta by 2 / 0.5 = 4x and clamps bounds
    assert.deepEqual(
      computeDraggedViewportSize({
        startViewport: { width: 1000, height: 600 },
        startZoom: 0.5,
        dx: 50,
        dy: -100,
        edge: 'corner',
      }),
      { width: 1200, height: 240 }
    )
    assert.deepEqual(
      computeDraggedViewportSize({
        startViewport: { width: 2400, height: 2500 },
        startZoom: 0.5,
        dx: 100,
        dy: 100,
        edge: 'corner',
      }),
      { width: 2560, height: 2560 }
    )
  })
})
