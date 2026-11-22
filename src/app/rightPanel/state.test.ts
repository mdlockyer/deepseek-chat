import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import {
  acquireSidePanelOverlayLock,
  clampSidePanelResizeWidth,
  closeActiveRightPanelKind,
  getActiveRightPanel,
  openRightPanel,
  registerOverlayLockListener,
  useSidePanelStore,
} from './state.js'

const resetPanelStore = (activeSessionId: string | null = 's1') => {
  useSidePanelStore.setState({
    activeSessionId,
    activePanels: {},
    panelAnimating: false,
    panelResizing: false,
    overlayLocks: 0,
    stageSize: null,
  })
}

describe('right panel resize clamping', () => {
  it('clamps resize width between 360px and min(window - 360, 72vw)', () => {
    assert.equal(clampSidePanelResizeWidth(240, 1200), 360)
    assert.equal(clampSidePanelResizeWidth(600.4, 1200), 600)
    // 1200 - 360 = 840 < 1200 * 0.72 = 864
    assert.equal(clampSidePanelResizeWidth(950, 1200), 840)
    // 1800 * 0.72 = 1296 < 1800 - 360 = 1440
    assert.equal(clampSidePanelResizeWidth(1400, 1800), 1296)
    // Narrow window still floors at 360px
    assert.equal(clampSidePanelResizeWidth(500, 600), 360)
  })
})

describe('right-rail coordination', () => {
  it('prevents closeActiveRightPanelKind("search") from closing an open preview or browser panel', () => {
    resetPanelStore('s1')
    openRightPanel('s1', 'preview')
    assert.equal(getActiveRightPanel('s1'), 'preview')

    // Message sends trigger closeSearchPanel() -> closeActiveRightPanelKind('search')
    closeActiveRightPanelKind('search')
    assert.equal(getActiveRightPanel('s1'), 'preview')

    openRightPanel('s1', 'search')
    assert.equal(getActiveRightPanel('s1'), 'search')
    closeActiveRightPanelKind('search')
    assert.equal(getActiveRightPanel('s1'), null)
  })

  it('fires shared overlay lock listeners only on 0->1 and 1->0 transitions', () => {
    resetPanelStore('s1')
    const events: boolean[] = []
    const unsub = registerOverlayLockListener((locked) => events.push(locked))

    const release1 = acquireSidePanelOverlayLock()
    const release2 = acquireSidePanelOverlayLock()
    assert.deepEqual(events, [true])

    release1()
    assert.deepEqual(events, [true])
    release1() // idempotent release
    assert.deepEqual(events, [true])

    release2()
    assert.deepEqual(events, [true, false])
    unsub()
  })
})
